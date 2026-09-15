import {
  anyGoal,
  createMovements,
  type Goal,
  setSneaking,
  SupportedPositionHold,
} from "../../../navigation/index.js";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import type { CombatOutcome } from "../../control/combat/contract.js";
import { isRangedAttacker } from "../../perception/combat/observations.js";
import { isThreat } from "../../perception/combat/threats.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { bowApproachGoal } from "../../positioning/combat/bow-approach.js";
import { COMBAT_APPROACH_RADIUS, CombatPosition } from "../../positioning/combat/position.js";
import { aimPoint, facing } from "../../weapons/aim.js";
import { MELEE_RANGE, selectRangedLoadout } from "../../weapons/equipment.js";
import {
  canMeleeTarget,
  combatItemsForTarget,
  hasMeleeKnockbackRoom,
  meleeApproachGoal,
  meleeDistance,
  waitingForDescendingCube,
} from "../../weapons/melee.js";
import { retreatFromCreepers } from "./creeper-retreat.js";

import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";
import { defendWhileRetreating } from "../../weapons/retreat-melee.js";

/** Routes, stationary support and impulse recovery share one physical movement owner. */
export class FightMovement {
  readonly footing: SupportedPositionHold;
  crouchingOnMagma = false;
  constructor(
    readonly scene: FightScene,
    readonly weapons: FightWeapons,
    readonly protectFooting: () => Promise<void> = () => weapons.maintainGuard(),
  ) {
    this.footing = new SupportedPositionHold(scene.bot, scene.navigation.world);
  }
  observeFooting() {
    if (this.scene.footingRecovery.active) return;
    if (this.scene.footingRecovery.needed) {
      this.footing.release();
      return;
    }
    this.footing.tick();
    if (!this.footing.active) return;
    const magma = this.scene.bot.blockAt(this.scene.bot.entity.position.offset(0, -0.01, 0))?.name === "magma_block";
    if (magma || this.crouchingOnMagma) setSneaking(this.scene.bot, magma);
    this.crouchingOnMagma = magma;
  }
  readonly volleyStop = {
    reason: "ranged volley needs combat facing",
    when: () =>
      this.weapons.volleyActive() &&
      (meleeDistance(this.scene.bot, this.scene.target) <= MELEE_RANGE || !facing(this.scene.bot, this.scene.target)),
  };
  readonly recoverFooting = () =>
    this.scene.execution.run("recover_footing", async () => {
      // Release the old stationary controller without waiting for the landing
      // that this recovery now owns. No two loops may drive the same controls.
      this.footing.release();
      try {
        if ((await this.scene.footingRecovery.recover(this.scene.signal, this.protectFooting)) === "failed")
          throw new Error("Footing recovery could not establish a safe landing.");
        const loadout = this.weapons.currentLoadout();
        await this.weapons.equip(loadout);
        if (loadout.kind === "melee") this.weapons.weaponReadyAt = this.scene.elapsedTicks + loadout.cooldownTicks;
      } finally {
        this.weapons.itemUse.invalidateShield();
        this.footing.start();
      }
      // Recovery can interrupt an awaited shield or weapon cooldown. Resume
      // that wait with a ready guard, rather than leaving it down until the
      // caller eventually returns to the outer combat loop.
      const loadout = this.weapons.currentLoadout();
      if (loadout.kind === "melee" && loadout.shield) await this.weapons.itemUse.raiseShield();
    });
  /** The route and the turn must agree on what counts as an attack position.
   * A firing line only satisfies this route when the turn may actually use the
   * bow. Arrow collection forbids bow use while the bow stays carried; admitting
   * its firing line here arrived at once, the melee turn found nothing in reach,
   * and the fight spun between guard and a zero-length approach without moving. */
  readonly approachGoal = (beganOutsideContact: boolean): Goal => {
    const melee = meleeApproachGoal(this.scene.bot, this.scene.target.id, this.scene.navigation.world);
    const permitted = permittedCombatItems(
      combatItemsForTarget(this.scene.bot, this.scene.target),
      this.scene.policy.combat,
    );
    if (!beganOutsideContact || !isRangedAttacker(this.scene.target) || !selectRangedLoadout(permitted)) return melee;
    return anyGoal([
      melee,
      bowApproachGoal(this.scene.bot, this.scene.target.id, () => aimPoint(this.scene.bot, this.scene.target)),
    ]);
  };
  readonly approach = async (
    guarded: boolean,
    stopWhen: {
      readonly reason: string;
      readonly when: () => boolean;
    } | null,
  ): Promise<string | null> =>
    this.scene.execution.run("approach", async () => {
      if (guarded) await this.weapons.raiseGuard();
      else if (this.weapons.itemUse.shieldRaised) this.weapons.itemUse.lowerShield();
      if (this.scene.settled()) return null;
      await this.footing.stop();
      const stop = new AbortController();
      // A route admitted out of reach may excavate. Once the target closes,
      // stop that route even if its intended fighting stance is not safe yet.
      // The next approach selects existing footing with digging disabled.
      const beganOutsideContact = !canMeleeTarget(this.scene.bot, this.scene.target);
      const watch = () => {
        if (this.scene.footingRecovery.needed) {
          stop.abort("external impulse requires footing recovery");
          return;
        }
        // Navigation's heading may cover the selected enemy while exposing a
        // different shooter. Incoming fire needs combat's projectile-facing
        // guard even when the selected enemy has no ranged attack.
        const defence = this.weapons.currentLoadout().shield ? this.weapons.projectileDefence() : null;
        if (defence && (defence.imminent || !defence.aligned || !guarded)) {
          if (!stop.signal.aborted) this.scene.reportDecision({ kind: "response", evidence: {
            boundary: "projectile_guard", stage: "stop_requested",
            projectileIds: defence.projectiles.map(({ entity }) => entity.id),
            windingUpIds: defence.windingUp.map((entity) => entity.id),
            impactInTicks: defence.projectiles.map(({ impactInTicks }) => impactInTicks),
            coversAll: defence.coversAll, aligned: defence.aligned,
          } });
          stop.abort("incoming projectile needs combat facing");
        } else if (stopWhen?.when()) stop.abort(stopWhen.reason);
        else if (
          meleeDistance(this.scene.bot, this.scene.target) <= MELEE_RANGE &&
          hasExposedBody(this.scene.bot, this.scene.target) &&
          (beganOutsideContact ||
            hasMeleeKnockbackRoom(
              this.scene.navigation.world,
              this.scene.bot.entity.position,
              this.scene.target.position,
            ))
        )
          stop.abort("target entered melee reach");
        else if (this.weapons.contact()) stop.abort("another hostile entered melee reach");
        else if (
          waitingForDescendingCube(this.scene.bot, this.scene.target) &&
          hasMeleeKnockbackRoom(this.scene.navigation.world, this.scene.bot.entity.position, this.scene.target.position)
        )
          stop.abort("cube is descending above melee stance");
        else if (this.weapons.currentLoadout().kind === "bow" && this.weapons.hasClearShot())
          stop.abort("target now calls for the carried bow with a clear shot");
      };
      // Navigation lowers the guard only through the hands: a dig or a
      // placement swaps or swings the main hand and a door is opened with
      // it, and Mineflayer clears its use flag on any slot change. A route
      // that only walked leaves the raised shield, and the five ticks of
      // readiness already paid for it, intact. Paying readiness again after
      // every route let a retreating skeleton step out of reach before each
      // swing: forty-four one-step approaches and four hits in one fight.
      let handsUsed = false;
      const stopObserving = this.scene.navigation.onEvent((event) => {
        if (event.kind === "step_phase" && ["breaking", "placing", "activating"].includes(event.phase))
          handsUsed = true;
      });
      this.scene.bot.on("physicsTick", watch);
      try {
        watch();
        const route = await this.scene.navigation.navigate({
          // Sprint only between threats; active shield use owns the guarded walk.
          movements: createMovements(this.scene.bot, {
            allowSprinting: !guarded,
            // Repositioning inside contact must use existing footing, not
            // excavate or scaffold a fighting stance while the attacker hits.
            allowDigging: beganOutsideContact && this.scene.policy.combat.terrain.dig,
            // Never scaffold up to a hovering shooter; the bow answers it from
            // the fighting level instead of stranding the bot on a pillar.
            scaffolding:
              beganOutsideContact && !isRangedAttacker(this.scene.target) && this.scene.policy.combat.terrain.place,
            // Never drop off a ledge to chase a hovering shooter. A blaze that
            // descends off the fortress bridge is out of melee reach, not an
            // invitation into the swarm below it; run 14's twelve-rod attempt
            // followed one down to y79 and bled out. A dived blaze is answered
            // by the bow or left unreached, and a walking mob still steps down
            // the one block an ordinary approach allows.
            maximumDrop: isRangedAttacker(this.scene.target) ? 1 : undefined,
          }),
          goal: this.approachGoal(beganOutsideContact),
          signal: this.scene.signal,
          stopSignal: stop.signal,
          // This route walks toward the thing the hostile field prices. Paying
          // that cost here would make the approach detour around its own target
          // or refuse it outright; combat is exempt by construction.
          stepField: null,
          searchLimits: { maximumRadius: COMBAT_APPROACH_RADIUS },
        });
        if (stop.signal.aborted) return null;
        return route.status === "stopped" ? route.reason : null;
      } finally {
        this.scene.bot.off("physicsTick", watch);
        stopObserving();
        if (handsUsed || !this.scene.bot.usingHeldItem) this.weapons.itemUse.invalidateShield();
        this.footing.start();
      }
    });
  readonly approachRoof = async (opening: Parameters<CombatPosition["approachRoof"]>[0]) =>
    this.scene.execution.run("approach", async () => {
      const stop = new AbortController();
      const provoking = opening().kind === "provoke";
      const watch = () => {
        if (this.scene.settled()) stop.abort("engagement ended");
        else if (this.scene.footingRecovery.needed) stop.abort("external impulse requires footing recovery");
        else if (this.weapons.contact()) stop.abort("another hostile entered melee reach");
        else if (provoking && this.scene.roofTargetHostile()) stop.abort("the selected enderman became hostile");
        else if (
          isThreat(this.scene.bot, this.scene.target, this.scene.perception) &&
          canMeleeTarget(this.scene.bot, this.scene.target)
        )
          stop.abort("attacker entered melee reach");
      };
      this.scene.bot.on("physicsTick", watch);
      try {
        if (this.weapons.currentLoadout().shield) await this.weapons.raiseGuard();
        watch();
        if (stop.signal.aborted) return { kind: "interrupted" } as const;
        const planned = await this.scene.position.approachRoof(opening, this.scene.signal, this.footing, stop.signal);
        if (stop.signal.aborted) return { kind: "interrupted" } as const;
        if (planned.kind !== "ready") return planned;
        const stopped = await this.scene.position.move(planned.plan.cell, this.scene.signal, this.footing, stop.signal);
        if (stop.signal.aborted) return { kind: "interrupted" } as const;
        return stopped ? ({ kind: "unreachable", reason: stopped } as const) : planned;
      } finally {
        this.scene.bot.off("physicsTick", watch);
        if (!this.scene.bot.usingHeldItem) this.weapons.itemUse.invalidateShield();
      }
    });
  readonly retreat = async (): Promise<CombatOutcome | null> => {
    if (!this.scene.policy.combat.retreat)
      return {
        ...this.scene.result("capability_blocked"),
        reason: "policy",
        observation: "[COMBAT_CONSTRAINED] Combat retreat is prohibited.",
      };
    // An incidental creeper can interrupt shielded melee. Releasing the
    // movement hold alone leaves use-item slowdown on the escape sprint.
    this.weapons.itemUse.lowerShield();
    await this.footing.stop();
    let clearance: Awaited<ReturnType<typeof retreatFromCreepers>>;
    const scene = this.scene;
    using defence = defendWhileRetreating(scene.bot, {
      attackerIds: scene.perception.attackerIds,
      resolvedIds: scene.dead,
      unreachableIds: new Set<number>(),
      get policy() { return scene.policy.combat; },
    }, scene.signal);
    try {
      clearance = await scene.execution.run("withdraw", () => retreatFromCreepers(scene.bot, scene.signal,
        () => scene.bot.health <= 0 || scene.footingRecovery.needed,
        { clearance: scene.perception.creeperClearance, tick: () => scene.perception.tick, dead: scene.perception.resolvedIds }));
    } finally {
      const evidence = defence.evidence();
      scene.attacks += evidence.attacks;
      if (evidence.attacks) scene.stylesUsed.add("melee");
      for (const weapon of evidence.weaponsUsed) scene.weaponsUsed.add(weapon);
      scene.reportDecision({ kind: "response", evidence: { boundary: "creeper_retreat", ...evidence } });
      this.footing.start();
    }
    // A local escape limit says nothing about reaching the quarry. Clearance
    // stays pending and the next shared tactic selects counter-hit or cover.
    scene.reportDecision({ kind: "response", evidence: { boundary: "blast_escape", result: clearance } });
    return null;
  };
  readonly positionEffect = async <T>(
    effect: (signal: AbortSignal) => Promise<T>,
  ): Promise<
    | {
        readonly kind: "completed";
        readonly value: T;
      }
    | {
        readonly kind: "interrupted";
      }
  > => {
    const impulse = new AbortController();
    const watch = () => {
      if (impulse.signal.aborted) return;
      const defence = this.weapons.currentLoadout().shield ? this.weapons.projectileDefence() : null;
      if (defence?.imminent) {
        this.scene.reportDecision({ kind: "response", evidence: {
          boundary: "projectile_guard", stage: "position_stop_requested",
          projectileIds: defence.projectiles.map(({ entity }) => entity.id),
          impactInTicks: defence.projectiles.map(({ impactInTicks }) => impactInTicks),
          coversAll: defence.coversAll, aligned: defence.aligned,
        } });
        impulse.abort("Incoming projectile interrupted the combat position effect.");
        this.scene.navigation.releaseForTakeover("Projectile guard is taking the combat body.");
        return;
      }
      if (!this.scene.footingRecovery.needed) return;
      impulse.abort("External impulse interrupted the combat position effect.");
      this.scene.navigation.releaseForTakeover("Combat footing recovery is taking the airborne body.");
    };
    this.scene.bot.on("physicsTick", watch);
    try {
      watch();
      if (impulse.signal.aborted) return { kind: "interrupted" };
      const value = await effect(AbortSignal.any([this.scene.signal, impulse.signal]));
      return impulse.signal.aborted ? { kind: "interrupted" } : { kind: "completed", value };
    } catch (cause) {
      this.scene.signal.throwIfAborted();
      if (!impulse.signal.aborted) throw cause;
      return { kind: "interrupted" };
    } finally {
      this.scene.bot.off("physicsTick", watch);
    }
  };
}
