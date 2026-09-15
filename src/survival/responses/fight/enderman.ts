import { Vec3 } from "vec3";
import { driveHorizontalSteering } from "../../../navigation/steering/local-steering.js";
import { standingCell } from "../../positioning/combat/geometry.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import { clearCombatRay } from "../../../world/entity-geometry.js";
import type { CombatOutcome } from "../../control/combat/contract.js";
import { positionThreat } from "../../perception/combat/observations.js";
import { roofLurePath, type RoofPosition } from "../../positioning/combat/planner.js";
import type { AttemptBudget, ProgressBudget } from "../../state/budgets.js";
import { aimPoint } from "../../weapons/aim.js";
import { canMeleeTarget } from "../../weapons/melee.js";
export type EndermanRoof =
  | { readonly kind: "unprepared" | "unavailable" }
  | { readonly kind: "provoking"; readonly plan: RoofPosition; readonly budget: AttemptBudget }
  | { readonly kind: "committed"; readonly cell: Vec3; readonly budget: ProgressBudget; hits: number };

import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

export type TacticalStep =
  { readonly kind: "ready" | "continue" } | { readonly kind: "outcome"; readonly outcome: CombatOutcome };
/** Provocation, roof preparation and confirmed-damage windows for one quarry. */
export class EndermanFight implements Disposable {
  state: EndermanRoof = { kind: "unprepared" };
  readonly heldTarget: ProgressBudget | null;
  private motionPosition: Vec3 | null = null;
  private stationarySince = 0;
  private nextBaitTick = 0;
  private returnPath: Vec3[] = [];
  constructor(
    readonly scene: FightScene,
    readonly weapons: FightWeapons,
    readonly locomotion: FightMovement,
  ) {
    this.heldTarget =
      scene.heightLimitedTarget && scene.movement === "hold"
        ? this.targetWindow("enderman_return", `target:${scene.targetId}`)
        : null;
  }
  readonly targetWindow = (name: string, scope: string) =>
    this.scene.survival.budgets.progress({
      name,
      scope,
      unit: "ticks",
      limit: this.scene.policy.combat.enderman_wait_ticks,
      measure: () => this.scene.elapsedTicks,
      progress: "confirmed_target_damage",
      exhaustion:
        "Return unreachable or reject this observed position; defensive hits and commands do not renew quarry progress.",
    });
  readonly setRoof = (next: EndermanRoof) => {
    if ("budget" in this.state) this.state.budget[Symbol.dispose]();
    this.state = next;
  };
  readonly provokeRoof = (plan: RoofPosition): EndermanRoof => ({
    kind: "provoking",
    plan,
    budget: this.scene.survival.budgets.attempt({
      name: "enderman_provocation",
      scope: `target:${this.scene.targetId}`,
      unit: "ticks",
      limit: this.scene.policy.combat.enderman_wait_ticks,
      measure: () => this.scene.elapsedTicks,
      exhaustion: "Return without constructing a roof when no hostility was observed.",
    }),
  });
  readonly reportRoof = (state: "waiting" | "hit" | "stopped", reason: string | null = null) => {
    if (this.state.kind !== "committed") return;
    this.scene.reportDecision({
      kind: "roof_engagement",
      targetId: this.scene.targetId,
      cell: this.state.cell,
      state,
      confirmedHits: this.state.hits,
      noProgressTicks: this.scene.policy.combat.enderman_wait_ticks - this.state.budget.remaining,
      reason,
    });
  };
  readonly commitRoof = () => {
    this.setRoof({
      kind: "committed",
      cell: this.scene.position.cell,
      budget: this.targetWindow("enderman_roof", `target:${this.scene.targetId}:cell:${this.scene.position.cell}`),
      hits: 0,
    });
    this.reportRoof("waiting");
  };
  readonly unreachableRoof = (reason: string): CombatOutcome => {
    this.reportRoof("stopped", reason);
    // This target made no progress. The hunt owns selecting the next quarry.
    return { ...this.scene.result("unreachable"), observation: reason };
  };
  refresh() {
    if (!this.motionPosition || this.motionPosition.distanceTo(this.scene.requestedTarget.position) >= 0.2) {
      this.motionPosition = this.scene.requestedTarget.position.clone();
      this.stationarySince = this.scene.elapsedTicks;
    }
    if (this.state.kind === "unavailable" && !this.scene.position.roofPreparationFailure())
      this.setRoof({ kind: "unprepared" });
  }
  confirmedHit() {
    this.heldTarget?.observe("confirmed_target_damage");
    if (this.state.kind !== "committed") return;
    this.state.hits++;
    this.state.budget.observe("confirmed_target_damage");
    this.reportRoof("hit");
  }
  /** Movement invites a stalled quarry; only damage renews the engagement budget. */
  async baitRoof(): Promise<void> {
    if (this.state.kind !== "committed" || this.scene.movement !== "pursue") return;
    await this.lureRoof(this.state.cell, false);
  }
  private async steerRoof(cell: Vec3, signal: AbortSignal, stop: () => boolean, provoke = false) {
    const destination = cell.offset(0.5, 0, 0.5);
    return driveHorizontalSteering({
      observe: () => ({ position: this.scene.bot.entity.position, yaw: this.scene.bot.entity.yaw }),
      setControl: (control, state) => this.scene.bot.setControlState(control, state),
      waitForTick: async () => {
        if (provoke && !this.scene.roofTargetHostile()) await this.weapons.face(this.scene.requestedTarget);
        else {
          await this.weapons.maintainGuard();
          await this.weapons.faceGuard();
          const loadout = this.weapons.currentLoadout();
          if (loadout.kind === "melee" && this.scene.roofTargetHostile() &&
            (!loadout.shield || this.weapons.itemUse.shieldRaised))
            await this.scene.execution.run("defend", async () => { this.weapons.strike(this.scene.requestedTarget, loadout); });
        }
        await waitForPhysicsTicks(this.scene.bot, 1, signal);
      },
    }, {
      signal, maximumTicks: 50,
      target: () => stop() || !this.scene.bot.entity.onGround ||
        !standingCell(this.scene.navigation.world, cell) ||
        !standingCell(this.scene.navigation.world, this.scene.bot.entity.position.floored())
        ? null : destination,
      arrived: () => this.scene.bot.entity.position.distanceTo(destination) < 0.15,
    });
  }
  private async returnToRoof(signal: AbortSignal): Promise<void> {
    while (this.returnPath.length) {
      const cell = this.returnPath.at(-1)!;
      const current = this.scene.bot.entity.position.floored();
      // Knockback can put the body outside the surveyed corridor. An old
      // waypoint is not permission to steer across the intervening terrain.
      if (current.y !== cell.y || Math.abs(current.x - cell.x) + Math.abs(current.z - cell.z) > 1) return;
      const moved = await this.steerRoof(cell, signal, () => this.scene.settled());
      if (moved.kind !== "arrived") return;
      this.returnPath.pop();
    }
  }
  private async lureRoof(cell: Vec3, provoke: boolean): Promise<void> {
    this.nextBaitTick = this.scene.elapsedTicks + 20;
    if (!this.scene.position.hasHeightProtection() || !this.scene.bot.entity.onGround) return;
    const path = roofLurePath(this.scene.navigation.world, cell, this.scene.requestedTarget.position);
    if (path.length < 2) return;
    const initial = this.scene.requestedTarget.position.clone();
    const responded = () => provoke ? this.scene.roofTargetHostile()
      : this.scene.requestedTarget.position.distanceTo(initial) >= 0.2;
    const stop = () => responded() || this.scene.settled() || ("budget" in this.state && this.state.budget.exhausted) || this.weapons.contact() !== null;
    if (this.weapons.currentLoadout().shield) await this.weapons.raiseGuard();
    this.scene.reportDecision({ kind: "response", evidence: {
      boundary: "enderman_roof_bait", stage: "out", targetId: this.scene.targetId,
      center: { ...cell.offset(0.5, 0, 0.5) }, path: path.map((at) => ({ ...at })), targetStart: { ...initial },
    } });
    await this.locomotion.positionEffect(async (signal) => {
      await this.locomotion.footing.stop(signal);
      try {
        await this.scene.execution.run("lure", async () => {
          for (let index = 1; index < path.length && !stop(); index++) {
            // Save the last reached waypoint before starting the next step.
            // A tactical interruption leaves this return route intact.
            this.returnPath.push(path[index - 1]!);
            const moved = await this.steerRoof(path[index]!, signal, stop, provoke);
            if (moved.kind !== "arrived") break;
          }
          this.scene.reportDecision({ kind: "response", evidence: {
            boundary: "enderman_roof_bait", stage: "return", targetId: this.scene.targetId,
            responded: responded(), targetStart: { ...initial }, targetNow: { ...this.scene.requestedTarget.position },
            position: { ...this.scene.bot.entity.position },
          } });
          await this.returnToRoof(signal);
        });
      } finally { this.locomotion.footing.start(); }
    });
    this.nextBaitTick = this.scene.elapsedTicks + 20;
    this.scene.reportDecision({ kind: "response", evidence: {
      boundary: "enderman_roof_bait", stage: "finished", targetId: this.scene.targetId,
      position: { ...this.scene.bot.entity.position }, centered: this.scene.position.at(cell),
    } });
  }
  async maintain(): Promise<TacticalStep> {
    if (this.returnPath.length) {
      const returned = await this.locomotion.positionEffect(async (signal) => {
        await this.locomotion.footing.stop(signal);
        try { await this.scene.execution.run("lure", () => this.returnToRoof(signal)); }
        finally { this.locomotion.footing.start(); }
      });
      if (returned.kind === "interrupted") return { kind: "continue" };
      if (this.returnPath.length && this.scene.bot.entity.onGround) {
        // Changed terrain can invalidate the saved path. Replan protection
        // from the observed position rather than retrying a blocked return.
        this.returnPath = [];
        this.setRoof({ kind: "unprepared" });
      }
      return { kind: "continue" };
    }
    if (this.state.kind === "committed") {
      const unusable = this.scene.movement === "pursue" &&
        standingCell(this.scene.navigation.world, this.state.cell) &&
        this.scene.elapsedTicks - this.stationarySince >= 10 &&
        this.scene.position.roofNeedsRelocation(observedEyeHeight(this.scene.bot.entity));
      const rejected = this.scene.position.unproductiveRoofs().has(`${this.state.cell}:${this.scene.requestedTarget.position.floored()}`);
      if (this.state.budget.exhausted || unusable || rejected) {
        const stalled = unusable || rejected
          ? "This shelter has no productive attack opening or level bait route to the quarry; seeking another position."
          : `No confirmed damage to enderman#${this.scene.targetId} for ${this.scene.policy.combat.enderman_wait_ticks} ticks from the roof; confirmed hits ${this.state.hits}.`;
        if (await this.weapons.defendContact()) return { kind: "outcome", outcome: this.unreachableRoof(stalled) };
        if (this.scene.movement === "hold" || canMeleeTarget(this.scene.bot, this.scene.target))
          return { kind: "outcome", outcome: this.unreachableRoof(stalled) };
        this.scene.position.rejectRoof(this.state.cell, stalled);
        this.reportRoof("stopped", "No confirmed damage from this roof; seeking a different protected melee position.");
        const planned = await this.locomotion.approachRoof(() => ({
          kind: "engage",
          target: positionThreat(this.scene.bot, this.scene.requestedTarget),
          eyeHeight: observedEyeHeight(this.scene.bot.entity),
          unproductive: this.scene.position.unproductiveRoofs(),
        }));
        if (planned.kind === "interrupted") {
          // The route can end because the attacker reached the new stance.
          // Its old roof's expired wait is no longer the current position.
          this.setRoof({ kind: "unprepared" });
          return { kind: "continue" };
        }
        if (planned.kind !== "ready")
          return {
            kind: "outcome",
            outcome: this.unreachableRoof(`${stalled} Roof reposition stopped: ${planned.reason}`),
          };
        this.setRoof(this.provokeRoof(planned.plan));
        return { kind: "continue" };
      }
      if (
        this.scene.bot.entity.onGround &&
        (!this.scene.position.cell.equals(this.state.cell) || !this.scene.position.hasHeightProtection())
      ) {
        const reason = "The committed enderman roof no longer protects the occupied fighting cell.";
        this.reportRoof("stopped", reason);
        this.setRoof({ kind: "unprepared" });
        return { kind: "continue" };
      }
    }

    return { kind: "ready" };
  }
  async prepare(guarded: boolean): Promise<TacticalStep> {
    // Existing protection already permits a safe melee provocation. Looking
    // through its ceiling for a neutral target's eyes would discard that roof.
    if (
      this.scene.heightLimitedTarget &&
      this.state.kind === "unprepared" &&
      this.scene.position.hasHeightProtection() &&
      canMeleeTarget(this.scene.bot, this.scene.target)
    )
      this.commitRoof();
    // Contact postpones construction; it is not a failed roof attempt. Keep
    // the unprepared state so a later teleport can open a safe building turn.
    if (this.scene.heightLimitedTarget && this.state.kind === "unprepared") {
      const answered = this.scene.position.roofPreparationFailure();
      if (answered && !this.scene.roofTargetHostile())
        return {
          kind: "outcome",
          outcome:
            answered.failure.kind === "materials_missing"
              ? {
                  ...this.scene.result("capability_blocked"),
                  reason: "building_materials",
                  observation: answered.failure.why,
                }
              : this.unreachableRoof(answered.failure.why),
        };
      if (answered) this.setRoof({ kind: "unavailable" });
    }
    if (
      this.scene.heightLimitedTarget &&
      this.state.kind === "unprepared" &&
      !(
        this.scene.roofTargetHostile() &&
        canMeleeTarget(this.scene.bot, this.scene.target) &&
        !this.scene.position.hasHeightProtection()
      )
    ) {
      this.setRoof({ kind: "unavailable" });
      const defending = this.scene.defendingAtStart || this.scene.roofTargetHostile();
      const planned = defending
        ? this.scene.position.planRoof({ kind: "protection" })
        : await this.locomotion.approachRoof(() => ({
            kind: "provoke",
            targetEye: aimPoint(this.scene.bot, this.scene.requestedTarget),
            eyeHeight: observedEyeHeight(this.scene.bot.entity),
          }));
      if (planned.kind === "interrupted") {
        this.setRoof({ kind: "unprepared" });
        return { kind: "continue" };
      }
      if (planned.kind !== "ready") {
        this.scene.position.rejectRoofPreparation(this.scene.position.cell, planned.reason, planned.kind);
        this.scene.reportDecision({
          kind: "roof_prepared",
          targetId: this.scene.targetId,
          cell: this.scene.bot.entity.position.floored(),
          stopped: planned.reason,
        });
        if (!defending)
          return {
            kind: "outcome",
            outcome:
              planned.kind === "materials_missing"
                ? {
                    ...this.scene.result("capability_blocked"),
                    reason: "building_materials",
                    observation: planned.reason,
                  }
                : this.unreachableRoof(`Enderman protection unavailable: ${planned.reason}`),
          };
        return { kind: "continue" };
      }
      const moved = defending
        ? await this.locomotion.positionEffect((effectSignal) =>
            this.scene.execution.run("approach", () =>
              this.scene.position.move(planned.plan.cell, effectSignal, this.locomotion.footing),
            ),
          )
        : { kind: "completed" as const, value: null };
      if (moved.kind === "interrupted") {
        this.setRoof({ kind: "unprepared" });
        return { kind: "continue" };
      }
      const stopped = moved.value;
      if (stopped) {
        this.scene.position.rejectRoofPreparation(this.scene.position.cell, stopped);
        if (!defending)
          return { kind: "outcome", outcome: this.unreachableRoof(`Enderman roof approach stopped: ${stopped}`) };
        return { kind: "continue" };
      }
      this.setRoof(this.provokeRoof(planned.plan));
    }
    // A provoked enderman can reach us before the first block is placed.
    // Keep the shield and answer that contact; its next teleport opens the
    // construction turn. Building now exposed the native slope hunter to a hit.
    if (
      this.scene.heightLimitedTarget &&
      this.state.kind === "provoking" &&
      this.scene.roofTargetHostile() &&
      canMeleeTarget(this.scene.bot, this.scene.target) &&
      !this.scene.position.hasHeightProtection()
    )
      this.setRoof({ kind: "unprepared" });
    if (this.scene.heightLimitedTarget && this.state.kind === "provoking") {
      if (!this.scene.defendingAtStart && !this.scene.roofTargetHostile()) {
        if (this.state.budget.exhausted)
          return {
            kind: "outcome",
            outcome: this.unreachableRoof(
              `No hostility observed from enderman#${this.scene.targetId} after ${this.scene.policy.combat.enderman_wait_ticks} provoking ticks; no roof blocks were spent.`,
            ),
          };
        if (this.state.plan.placements.length === 0 && this.scene.position.hasHeightProtection() &&
          roofLurePath(this.scene.navigation.world, this.state.plan.cell, this.scene.requestedTarget.position).some((at) =>
            clearCombatRay(this.scene.bot.world, at.offset(0.5, observedEyeHeight(this.scene.bot.entity), 0.5), aimPoint(this.scene.bot, this.scene.requestedTarget)))) {
          await this.lureRoof(this.state.plan.cell, true);
          return { kind: "continue" };
        }
        const eye = this.scene.bot.entity.position.offset(0, observedEyeHeight(this.scene.bot.entity), 0);
        if (!clearCombatRay(this.scene.bot.world, eye, aimPoint(this.scene.bot, this.scene.requestedTarget))) {
          // A moving quarry can occlude the previously observed gaze. Reach
          // a fresh opening within this same provocation window, before
          // spending roof blocks or declaring the target unreachable.
          const planned = await this.locomotion.approachRoof(() => ({
            kind: "provoke",
            targetEye: aimPoint(this.scene.bot, this.scene.requestedTarget),
            eyeHeight: observedEyeHeight(this.scene.bot.entity),
          }));
          if (planned.kind === "interrupted") {
            this.setRoof({ kind: "unprepared" });
            return { kind: "continue" };
          }
          if (planned.kind !== "ready")
            return {
              kind: "outcome",
              outcome: this.unreachableRoof(`Enderman lure obstructed before construction: ${planned.reason}`),
            };
          this.state = { ...this.state, plan: planned.plan };
          return { kind: "continue" };
        }
        if (guarded) await this.weapons.raiseGuard();
        await this.scene.execution.run("lure", async () => {
          await this.weapons.face(this.scene.requestedTarget);
          await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
        });
        return { kind: "continue" };
      }
      // Native hostility is the admission for construction, not a look or a
      // fixed delay. Stop staring and build the previously priced roof now.
      const plan = this.state.plan;
      this.scene.reportDecision({
        kind: "roof_provoked",
        targetId: this.scene.targetId,
        cell: plan.cell,
        plannedBlocks: plan.placements.length,
      });
      this.setRoof({ kind: "unavailable" });
      const built = await this.locomotion.positionEffect((effectSignal) =>
        this.scene.execution.run("establish", () => this.scene.position.buildRoof(plan, effectSignal)),
      );
      if (built.kind === "interrupted") {
        this.setRoof({ kind: "unprepared" });
        return { kind: "continue" };
      }
      const stopped = built.value;
      this.scene.reportDecision({
        kind: "roof_prepared",
        targetId: this.scene.target.id,
        cell: this.scene.bot.entity.position.floored(),
        stopped: stopped?.reason ?? null,
      });
      this.weapons.itemUse.invalidateShield();
      if (!stopped) this.commitRoof();
      else this.scene.position.rejectRoofPreparation(plan.cell, stopped.reason);
      return { kind: "continue" };
    }
    // Hostility was observed before construction. A roof hiding the eyes is
    // now useful protection, not a reason to abandon or reprovoke the target.
    if (
      this.scene.heightLimitedTarget &&
      !canMeleeTarget(this.scene.bot, this.scene.target) &&
      this.state.kind === "committed"
    ) {
      if (this.scene.movement === "pursue" && this.scene.elapsedTicks >= this.nextBaitTick && this.scene.elapsedTicks - this.stationarySince >= 10) {
        await this.baitRoof();
        return { kind: "continue" };
      }
      if (guarded) await this.weapons.raiseGuard();
      await this.scene.execution.run("hold", async () => {
        await this.weapons.faceGuard();
        await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
      });
      return { kind: "continue" };
    }
    // An unprotected approach must stop, but an idle defensive hold keeps its
    // guard across the attacker's teleport instead of ending and restarting.
    if (
      this.scene.heightLimitedTarget &&
      !canMeleeTarget(this.scene.bot, this.scene.target) &&
      this.scene.movement === "pursue"
    )
      return {
        kind: "outcome",
        outcome: this.unreachableRoof("Enderman is out of reach and no protected fighting position was established."),
      };
    // The same teleport-return window applies without a roof. Otherwise a
    // refused construction leaves automatic defence holding the body forever.
    if (this.heldTarget?.exhausted)
      return {
        kind: "outcome",
        outcome: this.unreachableRoof(
          `No confirmed damage to enderman#${this.scene.targetId} for ${this.scene.policy.combat.enderman_wait_ticks} ticks during defensive hold.`,
        ),
      };

    return { kind: "ready" };
  }
  [Symbol.dispose]() {
    this.heldTarget?.[Symbol.dispose]();
    if ("budget" in this.state) this.state.budget[Symbol.dispose]();
  }
}
