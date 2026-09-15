export const ARROW_RELEASE_GRACE_TICKS = 12;
export type GuardOutcome = "volley_finished" | "fight_ended" | "windup_limit" | "return_to_cover";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { observedEyeHeight, STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { exposedBodyFrom, nearestBodyPoint } from "../../../world/entity-geometry.js";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import { isRangedAttacker, positionThreat } from "../../perception/combat/observations.js";
import { arrowImpact, incomingShieldProjectiles } from "../../perception/combat/shield-projectiles.js";
import { arrowFlight } from "../../perception/combat/arrow-flight.js";
import { retreatGuardLimit } from "../../weapons/projectile-guard.js";
import { observeProjectileDefence } from "../../weapons/shield-facing.js";
import { isThreat } from "../../perception/combat/threats.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { positionWorld } from "../../positioning/combat/geometry.js";
import { aimPoint } from "../../weapons/aim.js";
import { bowTrajectory, clearBowTrajectory } from "../../weapons/bow-trajectory.js";
import {
  BOW_DRAW_TICKS,
  equipCombatLoadout,
  MELEE_RANGE,
  selectCombatLoadout,
  selectMeleeLoadout,
  selectRangedLoadout,
  type CombatLoadout,
} from "../../weapons/equipment.js";
import { assessBowWindow } from "../../weapons/bow-window.js";
import { CombatItemUse } from "../../weapons/item-use.js";
import {
  canMeleeTarget,
  combatItemsForTarget,
  hasMeleeKnockbackRoom,
  hasSweepBystander,
  meleeDistance,
} from "../../weapons/melee.js";
import { shieldCoverage, shieldFacing } from "../../weapons/shield-facing.js";
import { isCreeper } from "../../perception/combat/creepers.js";
import type { FightScene } from "./scene.js";

type Entity = Parameters<Bot["attack"]>[0];
/** Weapon use and readiness belong to this fight; movement can interrupt a wait. */
export class FightWeapons {
  readonly itemUse: CombatItemUse;
  weaponReadyAt = 0;
  volleyTicksRemaining: number;
  constructor(
    readonly scene: FightScene,
    readonly interruptions: { recoverFooting(): Promise<void>; returnToCover(): boolean },
  ) {
    this.itemUse = new CombatItemUse(scene.bot, (ticks) => this.holdFacing(ticks),
      (event) => scene.reportDecision({ kind: "response", evidence: { boundary: "item_use", ...event } }));
    this.volleyTicksRemaining =
      (scene.perception.read().find((entry) => entry.id === scene.target.id)?.windingUp ?? false)
        ? ARROW_RELEASE_GRACE_TICKS
        : 0;
  }
  observeVolley() {
    this.volleyTicksRemaining =
      (this.scene.perception.read().find((entry) => entry.id === this.scene.target.id)?.windingUp ?? false)
        ? ARROW_RELEASE_GRACE_TICKS
        : Math.max(0, this.volleyTicksRemaining - 1);
  }
  readonly contact = (): Entity | null => {
    const distance = canMeleeTarget(this.scene.bot, this.scene.target)
      ? Math.min(MELEE_RANGE, meleeDistance(this.scene.bot, this.scene.target)) : MELEE_RANGE;
    return (
      Object.values(this.scene.bot.entities)
        .filter(
          (entity) =>
            entity.id !== this.scene.target.id &&
            !this.scene.dead.has(entity.id) &&
            isThreat(this.scene.bot, entity, this.scene.perception) &&
            !isCreeper(entity) &&
            meleeDistance(this.scene.bot, entity) < distance,
        )
        .sort((a, b) => meleeDistance(this.scene.bot, a) - meleeDistance(this.scene.bot, b))
        .find((entity) => hasExposedBody(this.scene.bot, entity)) ?? null
    );
  };
  readonly face = async (entity = this.scene.target): Promise<void> => {
    await this.scene.bot.lookAt(aimPoint(this.scene.bot, entity), true);
    this.scene.signal.throwIfAborted();
  };
  readonly faceGuard = async (): Promise<void> => {
    await this.scene.bot.lookAt(shieldFacing(this.scene.bot, this.scene.target, this.scene.dead), true);
    this.scene.signal.throwIfAborted();
  };
  readonly projectileDefence = () => {
    const velocity = this.scene.bot.entity.velocity;
    // Reserve the distance the current horizontal motion can cover during
    // shield readiness. Actual hits always take priority over this warning.
    const allowance = Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0) * 5;
    return observeProjectileDefence(this.scene.bot, allowance);
  };
  /** Mineflayer sends movement immediately after physicsTick listeners return.
   * Forced look applies synchronously; awaiting the next tick would miss that send. */
  readonly aimGuardBeforeMovement = (): void => {
    if (!this.itemUse.shieldRaised || this.scene.signal.aborted || this.scene.footingRecovery.needed) return;
    const phase = this.scene.execution.snapshot(this.scene.attacks).phase;
    if (phase !== "guard" && phase !== "hold" && phase !== "swing" && phase !== "defend") return;
    const defence = this.projectileDefence();
    if (!defence) return;
    void this.scene.bot.lookAt(defence.facing, true).catch((error: unknown) => {
      this.scene.responseRequired.abort(error);
    });
  };
  readonly guardIncoming = async (): Promise<boolean> =>
    this.scene.execution.run("guard", async () => {
      this.scene.projectileGuards++;
      const initial = this.projectileDefence();
      if (initial) {
        await this.scene.bot.lookAt(initial.facing, true);
        this.scene.reportDecision({ kind: "response", evidence: {
          boundary: "projectile_guard", stage: "facing_applied",
          projectileIds: initial.projectiles.map(({ entity }) => entity.id),
          contacts: initial.projectiles.map(({ entity, contact, impactInTicks }) => ({ id: entity.id, contact: { x: contact.x, y: contact.y, z: contact.z }, impactInTicks })),
          heldProjectileId: initial.heldProjectileId, holdRemainingTicks: initial.holdRemainingTicks,
          windups: initial.windupForecasts.map(({ entity, releaseInTicks, impactInTicks }) => ({ id: entity.id, releaseInTicks, impactInTicks })),
          yaw: this.scene.bot.entity.yaw,
        } });
      }
      await this.raiseGuard();
      for (let tick = 0; tick < this.scene.policy.combat.volley_wait_ticks && !this.scene.settled(); tick++) {
        const guarded = this.itemUse.shieldRaised;
        await this.maintainGuard();
        if (guarded && !this.itemUse.shieldRaised) return true;
        if (this.scene.footingRecovery.needed) await this.interruptions.recoverFooting();
        const defence = this.projectileDefence();
        if (!defence || (!defence.imminent && defence.aligned)) {
          this.scene.reportDecision({ kind: "response", evidence: {
            boundary: "projectile_guard", stage: "guard_exited", reason: defence ? "aligned_guard_can_advance" : "no_exposed_threat",
            projectileIds: defence?.projectiles.map(({ entity }) => entity.id) ?? [],
            windingUpIds: defence?.windingUp.map((entity) => entity.id) ?? [],
          } });
          return true;
        }
        await this.scene.bot.lookAt(defence.facing, true);
        this.scene.signal.throwIfAborted();
        await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
      }
      return this.scene.settled();
    });
  /** Death ends attacking, but does not remove the volley already in flight. */
  readonly guardFinalVolley = async (): Promise<void> => {
    const pending = new Set(incomingShieldProjectiles(this.scene.bot, 2));
    if (!pending.size) return;
    await this.scene.execution.run("guard", async () => {
      this.scene.bot.clearControlStates();
      this.scene.reportDecision({ kind: "response", evidence: {
        boundary: "final_volley", stage: "started", projectileIds: [...pending].map((entity) => entity.id),
      } });
      while (pending.size) {
        await this.scene.responsiveness.checkpoint(this.scene.signal);
        this.scene.signal.throwIfAborted();
        await this.maintainGuard();
        if (!this.scene.policy.combat.shield || retreatGuardLimit(this.scene.bot, this.scene.policy.combat)) break;
        if (this.scene.footingRecovery.needed) await this.interruptions.recoverFooting();
        const defence = this.projectileDefence();
        const incoming = incomingShieldProjectiles(this.scene.bot, 2);
        for (const entity of pending)
          if (!incoming.includes(entity) && defence?.heldProjectileId !== entity.id) pending.delete(entity);
        // Do not extend this handoff for new shots or a surviving shooter's draw.
        const volley = incoming.filter((entity) => pending.has(entity));
        const held = defence && [...pending].some((entity) => entity.id === defence.heldProjectileId);
        if (!volley.length && !held) break;
        const { heading } = shieldCoverage(this.scene.bot.entity.position,
          volley.map((entity) => arrowImpact(this.scene.bot, entity, 2)?.position ?? arrowFlight(this.scene.bot, entity).position));
        await this.scene.bot.lookAt(held ? defence.facing : this.scene.bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0).plus(heading), true);
        this.scene.signal.throwIfAborted();
        await this.itemUse.raiseShield();
        // holdFacing intentionally stops at target death; this wait follows projectile lifetime instead.
        await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
      }
      this.scene.reportDecision({ kind: "response", evidence: {
        boundary: "final_volley", stage: "ended", reason: pending.size ? "guard_unavailable" : "volley_clear",
      } });
    });
  };
  readonly holdFacing = async (ticks: number): Promise<void> => {
    for (let held = 0; held < ticks && !this.scene.settled(); held += 1) {
      await this.maintainGuard();
      if (this.scene.footingRecovery.needed) await this.interruptions.recoverFooting();
      if (this.interruptions.returnToCover()) break;
      if (this.itemUse.shieldRaised) await this.faceGuard();
      else await this.face();
      await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
    }
  };
  readonly equip = async (loadout: CombatLoadout) => {
    const previous = this.scene.bot.heldItem?.name ?? null;
    await equipCombatLoadout(this.scene.bot, loadout);
    // A navigation dig can replace the sword with a pickaxe. Switching back
    // resets vanilla attack strength even if the previous swing was long ago.
    if (previous !== (this.scene.bot.heldItem?.name ?? null)) {
      this.itemUse.invalidateShield();
      if (loadout.kind === "melee") this.weaponReadyAt = this.scene.elapsedTicks + loadout.cooldownTicks;
    }
  };
  readonly readyWeapon = () =>
    this.scene.execution.run(this.itemUse.shieldRaised ? "guard" : "hold", async () => {
      while (
        this.scene.elapsedTicks < this.weaponReadyAt &&
        !this.scene.settled() &&
        !this.interruptions.returnToCover()
      )
        await this.holdFacing(this.weaponReadyAt - this.scene.elapsedTicks);
    });
  /** One ready hit, without owning a cooldown wait or stopping locomotion.
   * Sword attacks retain the active off-hand guard and reassert it afterward. */
  readonly strike = (target: Entity, loadout: Extract<CombatLoadout, { kind: "melee" }>): boolean => {
    this.scene.signal.throwIfAborted();
    if (!this.scene.policy.combat.melee || this.scene.elapsedTicks < this.weaponReadyAt ||
      this.scene.bot.heldItem?.name !== loadout.weapon?.name ||
      this.scene.settled() || !target.isValid || this.scene.dead.has(target.id) ||
      !canMeleeTarget(this.scene.bot, target) ||
      (loadout.weapon?.name.endsWith("_sword") && hasSweepBystander(this.scene.bot, target))) return false;
    this.scene.bot.attack(target);
    this.scene.attacks++;
    this.weaponReadyAt = this.scene.elapsedTicks + loadout.cooldownTicks;
    this.scene.stylesUsed.add(loadout.shield ? "shielded_melee" : "melee");
    this.scene.weaponsUsed.add(loadout.weapon?.name ?? "hand");
    if (loadout.shield) this.itemUse.activateShield();
    return true;
  };
  readonly bowWindow = (remainingDrawTicks: number) => assessBowWindow(
    this.projectileDefence(), remainingDrawTicks,
    // Preserve the blaze charge/release grace: an accelerating volley has no
    // dependable impact deadline. Hidden charges still permit approaching.
    this.scene.target.name === "blaze" && this.volleyActive(),
  );
  readonly guardRangedAttack = async (): Promise<GuardOutcome> =>
    this.scene.execution.run("guard", async () => {
      this.scene.projectileGuards += 1;
      let held = 0;
      await this.raiseGuard();
      return await this.itemUse.guardUntil<GuardOutcome>(() => {
        if (this.scene.settled()) return "fight_ended";
        if (this.interruptions.returnToCover()) return "return_to_cover";
        if (this.bowWindow(BOW_DRAW_TICKS).safe) {
          this.scene.execution.progress.volleyFinished();
          return "volley_finished";
        }
        return held++ >= this.scene.policy.combat.volley_wait_ticks ? "windup_limit" : null;
      });
    });
  readonly clearShot = (feet = this.scene.bot.entity.position) => {
    const eye = feet.offset(0, observedEyeHeight(this.scene.bot.entity), 0);
    const trajectory = bowTrajectory(eye.offset(0, -0.1, 0), aimPoint(this.scene.bot, this.scene.target));
    return trajectory &&
      clearBowTrajectory(trajectory, (from, direction, distance) =>
        this.scene.bot.world.raycast(from, direction, distance),
      )
      ? trajectory
      : null;
  };
  readonly hasClearShot = (): boolean => this.clearShot() !== null;
  readonly aimBow = async (): Promise<boolean> => {
    const trajectory = this.clearShot();
    if (!trajectory) return false;
    const eye = this.scene.bot.entity.position.offset(0, observedEyeHeight(this.scene.bot.entity), 0);
    await this.scene.bot.lookAt(eye.plus(trajectory.velocity), true);
    this.scene.signal.throwIfAborted();
    return true;
  };
  readonly shoot = async (shield: Item | null): Promise<GuardOutcome | "shot" | "obstructed"> =>
    this.scene.execution.run("shoot", async () => {
      if (!this.hasClearShot()) return "obstructed";
      const guardIfUnsafe = async (remaining: number, stage: string) => {
        if (!shield) return null;
        const window = this.bowWindow(remaining);
        if (stage !== "drawing" || !window.safe) this.scene.reportDecision({ kind: "response", evidence: {
          boundary: "bow_window", stage, remainingDrawTicks: remaining, ...window,
        } });
        return window.safe ? null : await this.guardRangedAttack();
      };
      const admission = await guardIfUnsafe(BOW_DRAW_TICKS, "admission");
      if (admission) return admission;
      using draw = this.itemUse.drawBow();
      for (let drawn = 0; drawn < BOW_DRAW_TICKS; drawn += 1) {
        if (this.interruptions.returnToCover()) return "return_to_cover";
        if (this.scene.settled()) {
          // The target is gone mid-draw; the arrow would fly at nothing.
          return "fight_ended";
        }
        const interrupted = await guardIfUnsafe(BOW_DRAW_TICKS - drawn, "drawing");
        if (interrupted) return interrupted;
        if (!(await this.aimBow())) return "obstructed";
        await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
      }
      this.scene.signal.throwIfAborted();
      if (this.scene.settled()) return "fight_ended";
      // A target can disappear behind a ledge on the final draw tick. Disposal
      // cancels by changing slots; deactivating the item here would fire it.
      if (!(await this.aimBow())) return "obstructed";
      const interrupted = await guardIfUnsafe(0, "release");
      if (interrupted) return interrupted;
      draw.release();
      this.scene.attacks += 1;
      return "shot";
    });
  readonly defendContact = async (): Promise<boolean> => {
    // The shared tactic admitted this attack window and interrupts it if a
    // fuse becomes urgent. The quarry's species cannot veto another attacker.
    if (!this.scene.policy.combat.melee) return false;
    const defender = this.contact();
    if (!defender) return false;
    return this.scene.execution.run("defend", async () => {
      const loadout = selectMeleeLoadout(
        permittedCombatItems(combatItemsForTarget(this.scene.bot, defender), this.scene.policy.combat),
      );
      await this.equip(loadout);
      if (loadout.shield) await this.raiseGuard();
      await this.readyWeapon();
      if (loadout.shield) await this.faceGuard();
      else await this.face(defender);
      if (
        this.scene.settled() ||
        !defender.isValid ||
        this.scene.dead.has(defender.id) ||
        !canMeleeTarget(this.scene.bot, defender)
      )
        return true;
      if (!this.strike(defender, loadout)) return true;
      await this.holdFacing(loadout.cooldownTicks);
      return true;
    });
  };
  readonly loadoutFrom = (feet: Vec3) => {
    // Endermen evade arrows by teleporting; a carried bow cannot answer this target.
    const available = permittedCombatItems(
      combatItemsForTarget(this.scene.bot, this.scene.target),
      this.scene.policy.combat,
    ).filter((item) => this.scene.target.name !== "enderman" || item.name !== "bow");
    if (this.scene.position.plan || this.scene.movement === "hold") {
      const eye = feet.offset(0, STANDING_EYE_HEIGHT, 0);
      // Holding a position forbids chasing. The six-block open-ground
      // weapon cutoff must not strand an otherwise reachable bow target.
      if (nearestBodyPoint(eye, positionThreat(this.scene.bot, this.scene.target)).distanceTo(eye) > MELEE_RANGE) {
        const ranged = selectRangedLoadout(available);
        if (ranged) return ranged;
      }
    }
    // Body reach can include an elevated target's feet. Choose the sword
    // when it can actually connect, rather than repeatedly choosing a bow
    // whose centre-directed trajectory is blocked by the ledge.
    if (!this.scene.policy.combat.melee) {
      const ranged = selectRangedLoadout(available);
      if (ranged) return ranged;
    }
    if (feet.equals(this.scene.bot.entity.position) && canMeleeTarget(this.scene.bot, this.scene.target))
      return selectMeleeLoadout(available);
    // The six-block cutoff anticipates a walking melee attacker closing
    // during the draw. A shooter outside swing reach can be answered here
    // when its bow trajectory is already clear, including a hovering blaze.
    if (isRangedAttacker(this.scene.target) && this.clearShot(feet)) {
      const ranged = selectRangedLoadout(available);
      if (ranged) return ranged;
    }
    return selectCombatLoadout(available, this.scene.target.position.minus(feet));
  };
  readonly currentLoadout = () => this.loadoutFrom(this.scene.bot.entity.position);
  /** A commanded guard is not proof that the off-hand item survived a hit. */
  readonly maintainGuard = async (): Promise<void> => {
    if (!this.itemUse.shieldRaised || this.scene.bot.inventory.slots[45]?.name === "shield") return;
    this.itemUse.invalidateShield();
    this.scene.signal.throwIfAborted();
    await this.raiseGuard();
  };
  readonly raiseGuard = async () => {
    if (!this.scene.policy.combat.shield) return;
    const shield = this.currentLoadout().shield;
    if (!shield || (this.itemUse.shieldRaised && this.scene.bot.inventory.slots[45]?.name === "shield")) return;
    return this.scene.execution.run("guard", async () => {
      if (shield && this.scene.bot.inventory.slots[45]?.name !== "shield") {
        await this.scene.bot.equip(shield, "off-hand");
        this.itemUse.invalidateShield();
      }
      this.scene.signal.throwIfAborted();
      await this.itemUse.raiseShield();
    });
  };
  readonly canAttackFrom = (feet: Vec3) => {
    if (this.loadoutFrom(feet).kind === "bow") return this.clearShot(feet) !== null;
    const eye = feet.offset(0, STANDING_EYE_HEIGHT, 0);
    const threat = positionThreat(this.scene.bot, this.scene.target);
    return (
      nearestBodyPoint(eye, threat).distanceTo(eye) <= MELEE_RANGE &&
      exposedBodyFrom(positionWorld(this.scene.navigation.world), eye, threat) &&
      hasMeleeKnockbackRoom(this.scene.navigation.world, feet, this.scene.target.position)
    );
  };
  readonly volleyActive = (): boolean => {
    // A blaze can retain its charge behind terrain. Guarding that flag
    // stopped every turn toward an approach dig, then retried the same dig.
    // A projectile already in flight still matters even if its shooter is hidden.
    if (incomingShieldProjectiles(this.scene.bot).length > 0) return true;
    const windingUp =
      this.scene.perception.read().find((entry) => entry.id === this.scene.target.id)?.windingUp ?? false;
    return (windingUp || this.volleyTicksRemaining > 0) && hasExposedBody(this.scene.bot, this.scene.target);
  };
}
