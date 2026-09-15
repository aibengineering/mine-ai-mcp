import { isIncomingArrow } from "../../perception/combat/shield-projectiles.js";
import { Vec3 } from "vec3";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import type { CombatOutcome } from "../../control/combat/contract.js";
import { isRangedAttacker } from "../../perception/combat/observations.js";
import { targetFacts } from "../../perception/combat/target.js";
import { canBeBystander, isHostile } from "../../perception/combat/threats.js";
import { compareTargets } from "../../policy/combat/target-utility.js";
import { decideCombatPosition, positionExposed, projectileReachesBody } from "../../positioning/combat/exposure.js";
import { positionWorld, standingBody } from "../../positioning/combat/geometry.js";
import { type ProtectionRefusal } from "../../positioning/combat/position.js";
import { shieldAnswersThreats } from "../../weapons/aim.js";
import { BOW_DRAW_TICKS, MELEE_RANGE } from "../../weapons/equipment.js";
import { canMeleeTarget, hasMeleeKnockbackRoom, meleeDistance } from "../../weapons/melee.js";
import { recoverUnderCover } from "../recover.js";
import { isCreeper } from "../../perception/combat/creepers.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** The current fighting refuge and its complete maintenance/peek cycle. */
export class CoverFight {
  get recovering(): boolean {
    return this.scene.recoveryTarget !== null;
  }
  peekAttacks = 0;
  failedPeeks = 0;
  constructor(
    readonly scene: FightScene,
    readonly weapons: FightWeapons,
    readonly locomotion: FightMovement,
  ) {}
  readonly positionFacts = () => {
    const plan = this.scene.position.plan;
    if (!plan) return null;
    const rays = positionWorld(this.scene.navigation.world);
    const body = standingBody(plan.fighting);
    const bow = this.weapons.currentLoadout().kind === "bow";
    const atProtection = this.scene.position.at(plan.protected);
    const defender =
      this.weapons.contact() ??
      (meleeDistance(this.scene.bot, this.scene.target) <= MELEE_RANGE &&
      hasExposedBody(this.scene.bot, this.scene.target)
        ? this.scene.target
        : null);
    const windupNeedsCover = (id: number) => {
      const observed = this.scene.perception.read().find((entry) => entry.id === id);
      return (
        observed?.windingUp === true &&
        (observed.firstShotInTicks === null || observed.firstShotInTicks <= BOW_DRAW_TICKS)
      );
    };
    const exposingThreats = this.scene.position
      .threats()
      .filter(
        (threat) =>
          threat.id !== this.scene.target.id &&
          positionExposed(rays, body, threat) &&
          (threat.attack !== "projectile" || (!atProtection && windupNeedsCover(threat.id))),
      );
    const incomingProjectiles = Object.values(this.scene.bot.entities).filter(
      (entity) => entity.isValid && ((entity.name === "small_fireball" && projectileReachesBody(rays, entity, body)) || isIncomingArrow(this.scene.bot, entity, 0, body)),
    );
    const targetWindingUp =
      !atProtection && bow && this.weapons.currentLoadout().shield === null && windupNeedsCover(this.scene.target.id);
    return {
      threatIds: exposingThreats.map((threat) => threat.id),
      projectileIds: incomingProjectiles.map((entity) => entity.id),
      targetWindingUp,
      protected: this.scene.position.protected(),
      atProtection,
      hurt: this.scene.boundaryDecision.kind === "recover",
      canDefendHere:
        defender !== null &&
        this.scene.bot.entity.onGround &&
        hasMeleeKnockbackRoom(this.scene.navigation.world, this.scene.bot.entity.position, defender.position),
      canAttack: this.weapons.canAttackFrom(body.position),
      attackExposed:
        exposingThreats.length > 0 ||
        incomingProjectiles.length > 0 ||
        // With a shield, the ordinary volley guard owns the target's
        // windup. Returning on its flag before that guard runs makes the
        // bot peek forever: a hidden shooter may retain its charged flag.
        // Crossfire and incoming projectiles still require a return above.
        targetWindingUp,
    };
  };
  readonly returnToCover = () => {
    const facts = this.positionFacts();
    return facts !== null && !facts.atProtection && decideCombatPosition(facts) !== "attack";
  };
  readonly moveWithinCover = async (
    cell: Vec3,
    signal: AbortSignal,
  ): Promise<
    | {
        kind: "arrived" | "fire_blocked";
      }
    | {
        kind: "failed";
        reason: string;
      }
  > => {
    // The refuge protects a destination, not every step through its opening.
    // Carry a ready shield through the same walking handoff as an approach.
    if (this.weapons.currentLoadout().shield) await this.weapons.raiseGuard();
    else this.weapons.itemUse.lowerShield();
    try {
      const passage: Vec3[] = [];
      if (this.scene.position.plan && !this.scene.position.at(cell)) {
        const plan = this.scene.position.plan;
        passage.push(...(cell.equals(plan.protected) ? [plan.entrance, plan.corner] : [plan.corner, plan.entrance]));
      }
      for (const step of [...passage, cell]) {
        if ((await this.scene.position.extinguishFireAt(step, signal)) === "blocked") {
          await this.scene.execution.run("hold", () => this.weapons.holdFacing(1));
          return { kind: "fire_blocked" };
        }
        const stopped = await this.scene.position.move(step, signal, this.locomotion.footing);
        if (stopped) {
          // A later impact can ignite the destination while its route is
          // running. Re-enter maintenance instead of discarding this refuge.
          if (this.scene.position.fireAt(step) || this.scene.position.fireAt(step.offset(0, 1, 0))) {
            await this.scene.execution.run("hold", () => this.weapons.holdFacing(1));
            return { kind: "fire_blocked" };
          }
          return { kind: "failed", reason: stopped };
        }
      }
      return { kind: "arrived" };
    } finally {
      this.weapons.itemUse.invalidateShield();
    }
  };
  readonly establishCover = async (signal: AbortSignal): Promise<ProtectionRefusal | null> =>
    this.scene.execution.run("establish", async () => {
      if (this.weapons.currentLoadout().shield) await this.weapons.raiseGuard();
      else this.weapons.itemUse.lowerShield();
      try {
        const stopped = await this.scene.position.establish(signal, this.locomotion.footing);
        if (!stopped && this.scene.position.plan && this.scene.position.protected())
          this.scene.execution.progress.milestone("protection", this.scene.position.plan.protected.toString());
        return stopped;
      } finally {
        this.weapons.itemUse.invalidateShield();
      }
    });
  readonly keepPosition = async (
    signal: AbortSignal,
  ): Promise<
    | {
        kind: "continue";
      }
    | {
        kind: "proceed";
      }
    | {
        kind: "outcome";
        outcome: CombatOutcome;
      }
  > => {
    if (!this.scene.position.plan && this.scene.movement === "pursue") {
      // A shooter can walk into melee as its old refuge loses cover. Contact
      // defence must run before pricing a replacement building project.
      if (this.weapons.contact() || canMeleeTarget(this.scene.bot, this.scene.target)) return { kind: "proceed" };
      if (isRangedAttacker(this.scene.target)) this.scene.position.adoptExisting();
      const rays = positionWorld(this.scene.navigation.world);
      const exposed = this.scene.position
        .threats()
        .filter((threat) => threat.attack === "projectile" && positionExposed(rays, this.scene.bot.entity, threat));
      // Crossfire cannot be answered by facing one shooter. A missing
      // shield also removes the ordinary guarded approach.
      const shieldAnswersExposure = shieldAnswersThreats(this.scene.bot, this.weapons.currentLoadout().shield, exposed);
      if (
        !this.scene.position.plan &&
        this.scene.position.canEstablish &&
        exposed.length > 0 &&
        !shieldAnswersExposure
      ) {
        // Cover is optional protection, not admission to the whole fight.
        // Price it before taking the body for construction; the ordinary
        // shield/attack and health-boundary responses remain available.
        if (this.scene.position.planCover().kind === "materials_missing") return { kind: "proceed" };
        const stopped = await this.establishCover(signal);
        if (!stopped) return { kind: "continue" };
        // Construction changed the world and left material for another
        // arrangement. Reobserve it; an unchanged refusal cannot retry.
        if (stopped.kind === "materials_missing") return { kind: "proceed" };
        if (this.scene.position.canEstablish) return { kind: "continue" };
        // The cover search remembers this refusal. It does not establish that
        // the enemy is unreachable; ordinary approach and contact defence remain.
        this.scene.reportDecision({ kind: "response", evidence: {
          boundary: "optional_cover", stage: "unavailable", reason: stopped.reason,
        } });
        return { kind: "proceed" };
      }
    }
    const plan = this.scene.position.plan;
    if (!plan) {
      this.scene.protectedProgress.leave();
      return { kind: "proceed" };
    }
    const protectedWindow = this.scene.protectedProgress.enter(plan.protected.toString());
    if (!this.recovering && protectedWindow.exhausted) {
      this.scene.reportDecision({
        kind: "position_rejected",
        targetId: this.scene.target.id,
        position: plan.protected,
        reason: `No confirmed quarry damage during ${this.scene.policy.combat.protected_wait_ticks} protected waiting ticks.`,
      });
      this.scene.position.rejectCover();
      this.scene.protectedProgress.leave();
      this.failedPeeks = 0;
      return { kind: "continue" };
    }
    if ((await this.scene.position.extinguishFireAt(this.scene.bot.entity.position.floored(), signal)) === "blocked") {
      // Keep the refuge and retry a temporary obstruction within the
      // same protected-wait budget. Never navigate through the fire.
      await this.scene.execution.run("hold", () => this.weapons.holdFacing(1));
      return { kind: "continue" };
    }
    this.scene.position.findAttackOpening(this.weapons.canAttackFrom);
    const facts = this.positionFacts()!;
    if (facts.atProtection && facts.protected)
      this.scene.execution.progress.milestone("protection", plan.protected.toString());
    const decision = decideCombatPosition(facts);
    if (decision === "establish") {
      this.scene.position.plan = null; // Dynamic exposure invalidates the position; never keep claiming it is safe.
      return { kind: "proceed" };
    }
    if (decision === "return") {
      if (this.scene.attacks === this.peekAttacks) this.failedPeeks++;
      else this.failedPeeks = 0;
      this.scene.reportDecision({
        kind: "cover_return",
        targetId: this.scene.target.id,
        threatIds: facts.threatIds,
        projectileIds: facts.projectileIds,
        targetWindingUp: facts.targetWindingUp,
        hurt: facts.hurt,
        canAttack: facts.canAttack,
        failedPeeks: this.failedPeeks,
      });
      if (this.failedPeeks >= 3) {
        const candidates = this.scene.perception
          .read()
          .filter(
            (entry) =>
              entry.id !== this.scene.target.id &&
              entry.windingUp &&
              isHostile(entry.entity) &&
              !canBeBystander(this.scene.bot, entry.entity) &&
              !isCreeper(entry.entity),
          );
        candidates.sort(
          (a, b) =>
            compareTargets(
              targetFacts(this.scene.bot, a.entity, a.hasHitUs),
              targetFacts(this.scene.bot, b.entity, b.hasHitUs),
            ) || a.id - b.id,
        );
        const blocker = candidates[0];
        if (blocker) {
          this.scene.focus(blocker.entity);
        }
        this.failedPeeks = 0;
      }
      const moved = await this.scene.execution.run("return", () => this.moveWithinCover(plan.protected, signal));
      if (moved.kind === "failed") {
        return {
          kind: "outcome",
          outcome: { ...this.scene.result("unreachable"), observation: `Return to cover stopped: ${moved.reason}` },
        };
      }
      return { kind: "continue" };
    }
    if (decision === "hold") {
      // A blind refuge is still protection. Keep the engagement's wait
      // budget until an attack opening is observed; discarding the plan
      // neither finds a replacement nor consumes construction material.
      this.weapons.itemUse.lowerShield();
      const response = this.scene.boundaryDecision;
      if (response.kind === "recover") {
        const recovery = await this.scene.execution.run("recover", () =>
          recoverUnderCover(this.scene.bot, {
            signal,
            recoverTo: response.health,
            maximumMs: this.scene.policy.combat.recovery_timeout_ms,
            survival: this.scene.survival,
            policy: () => this.scene.policy.effective,
            isProtected: () => !this.scene.settled() && this.scene.position.protected(),
            defendIntruder: async () => {
              await this.weapons.defendContact();
            },
            releaseItemUse: () => this.weapons.itemUse.lowerShield(),
            wait: this.weapons.holdFacing,
          }),
        );
        this.weapons.itemUse.invalidateShield();
        this.scene.recoveryTarget = null;
        if (recovery.kind === "held") {
          return {
            kind: "outcome",
            outcome: {
              ...this.scene.result("capability_blocked"),
              reason: "recovery",
              observation: `Protected recovery stopped before health and food were restored: ${recovery.reason}.`,
            },
          };
        }
        return { kind: "continue" };
      }
      await this.scene.execution.run("hold", () => this.weapons.holdFacing(1));
      return { kind: "continue" };
    }
    if (facts.atProtection) this.peekAttacks = this.scene.attacks;
    const moved = facts.protected
      ? await this.scene.execution.run("approach", () => this.moveWithinCover(plan.fighting, signal))
      : ({ kind: "arrived" } as const);
    if (moved.kind === "failed") {
      return {
        kind: "outcome",
        outcome: {
          ...this.scene.result("unreachable"),
          observation: `Move to fighting position stopped: ${moved.reason}`,
        },
      };
    }
    if (moved.kind === "fire_blocked") return { kind: "continue" };
    // Only confirmed damage to the requested quarry renews this window.
    return { kind: "proceed" };
  };
}
