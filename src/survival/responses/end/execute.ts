import { buildCrystalStaircase, pillarShortfall, planCrystalStaircase } from "../../positioning/combat/crystal-staircase.js";
import { standingCell } from "../../positioning/combat/geometry.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { eatFood } from "../../../actions/eat-food/eat-food.js";
import {
  createMovements,
  exactBlockGoal,
  nearXzGoal,
  packKey,
  type Goal,
  type NavigationRuntime,
} from "../../../navigation/index.js";
import { CLIMBABLES } from "../../../navigation/mineflayer/world.js";
import type { MovementPolicy } from "../../../navigation/movements/policy.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import {
  cloudExposure,
  dragonDanger,
  dragonExposure,
  incomingDragonBodies,
  incomingDragonFireballs,
  observeDragonEscape,
  perchedDragonContact,
  readDragonBreathHazards,
} from "../../../world/dragon-hazards.js";
import { entityHealth, dragonPhase, isDragonLanding, isDragonPerched, observedDragonLandingCenter, perchAttackCell, perchedDragonHead, perchedDragonBodyParts } from "../../../world/end-fight.js";
import { nearestBodyPoint } from "../../../world/entity-geometry.js";
import { REGENERATION_HUNGER } from "../../../world/food.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { selectPolicyFood } from "../../perception/food.js";
import type { CombatExecution, CombatPhase } from "../../control/combat/execution.js";
import type { ResponseContext } from "../../control/combat/context.js";
import { recoveryAvailable } from "../../perception/combat/recovery.js";
import type { CrystalEvidence, CrystalObservation } from "../../perception/combat/crystal.js";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import { endermanGazeRisk } from "../../perception/combat/gaze.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import { PerchPreparation } from "../../perception/combat/perch-preparation.js";
import type { SurvivalPolicy } from "../../policy/contract.js";
import { decideEndResponse } from "../../policy/combat/end-decision.js";
import { permittedCombatItems, permitsHide } from "../../policy/combat/permissions.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import { fullProtectionBlock } from "../../positioning/combat/build-protection.js";
import { countCapBlocks, DRAGON_PROTECTION_BLOCKS } from "../../positioning/combat/hide-blocks.js";
import { protectionShell } from "../../positioning/combat/planner.js";
import {
  crystalBlastCoverCell,
  crystalBlastEstimate,
  crystalMeleeAim,
  crystalReturnGoal,
} from "../../positioning/combat/crystal-melee.js";
import { type SurvivalResources } from "../../state/resources.js";
import { bowTrajectory, clearBowTrajectory } from "../../weapons/bow-trajectory.js";
import { fitsDragonShot } from "../../weapons/dragon-shot.js";
import {
  equipCombatLoadout,
  readCombatItems,
  selectMeleeLoadout,
  selectRangedLoadout,
} from "../../weapons/equipment.js";
import { CombatItemUse } from "../../weapons/item-use.js";
import {
  canMeleeTarget,
  combatItemsForTarget,
  distanceToBody,
  hasSweepBystander,
  meleeDistance,
} from "../../weapons/melee.js";
import { FootingRecovery } from "../footing.js";
import { enclosedInPlace, hideInPlace, WALL_IN_BLOCKS } from "../hide.js";
import type { Facts } from "../../state/answered.js";

export interface EndCombatResult {
  readonly outcome: "crystal_destroyed" | "shot_missed" | "dragon_damaged" | "weapon_unavailable" | "perch_ready" | "perch_approaching" | "perch_ended" | "dragon_died" | "evaded" | "stopped";
  readonly attacks: number;
  readonly healthBefore: number | null;
  readonly healthAfter: number | null;
  readonly reason: string | null;
  readonly crystal?: CrystalEvidence;
  readonly bow?: DragonShotObservation["evidence"];
  readonly perch?: {
    readonly preparedPosition: { x: number; y: number; z: number } | null;
    readonly stage: PerchObservation["stage"];
    readonly blockedBy: string | null;
    readonly timing?: PerchObservation["timing"];
  };
}
type EndMoveResult = { kind: "arrived" } | { kind: "changed" } | { kind: "failed"; reason: string };
/** Health points held back beyond the blast estimate before an exposed swing. */
const CRYSTAL_BLAST_MARGIN = 2;

// Vanilla ServerLevel sends explosion packets only when distance squared is
// below 4096. Beyond this range a destroyed crystal can vanish without a receipt.
const EXPLOSION_RECEIPT_RANGE = 64;

/** The combat controller delegates End mechanics here while retaining body ownership. */
export class EndCombat {
  constructor(
    private readonly bot: Bot,
    private readonly navigation: NavigationRuntime,
    private readonly footing: FootingRecovery,
    private readonly policy: () => Readonly<SurvivalPolicy>,
    private readonly survival: SurvivalResources,
    private readonly execution: CombatExecution,
    private readonly threatContext: ResponseContext,
    private readonly recordDecision: (evidence: Facts) => void,
    private readonly perchPreparation = new PerchPreparation(),
  ) {}

  private phase<T>(phase: CombatPhase, effect: () => Promise<T>): Promise<T> {
    return this.execution.run(phase, effect);
  }

  get danger(): boolean {
    return dragonDanger(this.bot);
  }

  async evade(signal: AbortSignal): Promise<EndCombatResult> {
    return this.phase("withdraw", () => this.escape(signal));
  }

  private async escape(signal: AbortSignal): Promise<EndCombatResult> {
    const response = decideEndResponse(this.policy().combat, this.danger, "evade");
    if (response.kind === "constrained") return this.result("stopped", response.reason);
    const bot = this.bot;
    // A warning often interrupts a scaffold jump. Decide about enclosure at
    // the observed landing, before admitting a route that can leave the tower.
    await this.settle(signal);
    // The ordinary enclosure owns construction, eating and recovery. Only its
    // hazard constraints differ here: intact dragon-resistant floor/walls and
    // no release while the flying body still threatens this cell.
    let shelterFailure: string | null = null;
    if (this.canShelter()) {
      const origin = bot.entity.position.floored();
      const deadline = Date.now() + this.policy().combat.evade_timeout_ms;
      const unsafe = () => {
        const floor = bot.blockAt(origin.offset(0, -1, 0));
        if (!fullProtectionBlock(floor) || !DRAGON_PROTECTION_BLOCKS.includes(floor!.name) ||
          !bot.entity.position.floored().equals(origin))
          return "Dragon shelter lost its supported cell.";
        if (dragonExposure(bot, bot.entity.position) > 0 || incomingDragonFireballs(bot).length || perchedDragonContact(bot, bot.entity.position))
          return "Dragon breath, projectile or perched contact makes the shelter unsafe.";
        if (Date.now() >= deadline && !enclosedInPlace(bot, DRAGON_PROTECTION_BLOCKS))
          return "Dragon shelter construction exhausted the escape window.";
        return null;
      };
      this.recordDecision({ response: "dragon_shelter", state: "started", cell: origin.toString(), health: bot.health });
      const hidden = await this.phase("recover", () => hideInPlace(bot, {
        signal,
        threatContext: this.threatContext,
        recoverTo: this.policy().combat.recover === "never"
          ? this.policy().combat.engage_min_health
          : recoveryHealth(this.policy().combat),
        maximumMs: this.policy().combat.recovery_timeout_ms,
        blockNames: DRAGON_PROTECTION_BLOCKS,
        firstWallDirection: bot.entity.position.minus(incomingDragonBodies(bot)[0]?.position ?? bot.entity.position),
        unsafe,
        holdWhile: () => incomingDragonBodies(bot).length > 0,
      }));
      this.recordDecision({ response: "dragon_shelter", state: hidden.kind, cell: origin.toString(),
        dug: hidden.dug, walled: hidden.walled, capped: hidden.capped, enclosed: hidden.enclosed,
        ate: hidden.ate, healthAfter: hidden.healthAfter, hungerAfter: hidden.hungerAfter,
        error: hidden.error ?? null });
      if (hidden.kind === "recovered" && !this.danger) return this.result("evaded");
      shelterFailure = `[END_SHELTER_STOPPED] ${hidden.error ?? "Dragon danger returned before the shelter could be released."} Health ${bot.health}, hunger ${bot.food}. This action has stopped; inspect the shelter and recovery supplies before retrying.`;
      // An intact hold with unavailable/exhausted healing is an actionable stop,
      // not permission to reopen the walls and resume crystal attacks wounded.
      if (hidden.kind === "held") return this.result("stopped", shelterFailure);
    }
    const maximumMs = this.policy().combat.evade_timeout_ms;
    using budget = this.survival.budgets.attempt({
      name: "dragon_evade",
      scope: `cell:${bot.entity.position.floored()}`,
      unit: "milliseconds",
      measure: Date.now,
      limit: maximumMs,
      exhaustion: "Return exhausted End escape; changed clouds and interrupted routes do not renew the attempt.",
    });
    let excavationInterrupted = false;
    while (this.danger) {
      signal.throwIfAborted();
      if (budget.exhausted)
        return this.result("stopped", `Dragon escape exhausted its ${maximumMs}-millisecond physical attempt.`);
      const projectiles = incomingDragonFireballs(bot);
      const start = bot.entity.position.clone();
      const goal: Goal = {
        resolve: () => {
          const geometry = observeDragonEscape(bot);
          const current = bot.entity.position.clone();
          const cell = current.floored();
          return {
            kind: "active",
            revision: `dragon-escape:${geometry.revision}:${current}`,
            heuristic: () => 0,
            isSatisfied: ({ feet }) => {
              const p =
                feet.x === cell.x && feet.y === cell.y && feet.z === cell.z
                  ? current
                  : new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5);
              // A five-block dodge can still land inside the growing seven-
              // block cloud. Vertical separation alone also leads into shafts.
              return geometry.clearAt(p) && (projectiles.length === 0 || Math.hypot(p.x - start.x, p.z - start.z) >= 9);
            },
          };
        },
      };
      const healthBefore = bot.health;
      const movements = this.movements();
      const landingDragons = Object.values(bot.entities).filter(
        (entity) => entity.isValid && entity.name === "ender_dragon" && dragonPhase(bot, entity) === 3,
      );
      const moved = await this.move(
        goal,
        signal,
        // The conservative flying-body route is obsolete once landing ends.
        // It must not finish carrying a now-safe bot away during its short
        // opportunity to approach the settled head.
        () => landingDragons.some((dragon) => isDragonPerched(dragonPhase(bot, dragon))) && !this.danger,
        {
          ...movements,
          // Escape follows supported terrain or excavates an exit. Building a
          // narrow aerial bridge during a dragon approach exposed the descending
          // crystal attacker to repeated wing knockback and a fatal fall.
          allowPlacing: false,
          scaffold: null,
          allowDigging: movements.allowDigging && !excavationInterrupted,
        },
        budget.remaining,
      );
      // A cloud hit interrupted excavation once per second in the native
      // fight. Recovery kept restarting the same unfinished second block.
      // Keep recovery, but use an existing passage for the rest of this escape.
      if (moved.kind === "changed" && bot.health < healthBefore) excavationInterrupted = true;
      if (moved.kind === "failed") return this.result("stopped",
        `[END_ESCAPE_BLOCKED] No clear escape route was reached from ${bot.entity.position}. ${moved.reason}. Inspect the current clouds and terrain, then choose another supported exit; this action has stopped.`);
      await this.tick(signal);
    }
    return shelterFailure ? this.result("stopped", shelterFailure) : this.result("evaded");
  }

  private canShelter(): boolean {
    const bot = this.bot;
    const policy = this.policy();
    // Landing has its own low approach. Closing that opening obstructed the
    // prepared head route in the native regression; keep separation for it.
    if (!bot.entity.onGround || !incomingDragonBodies(bot).some(body => !isDragonLanding(body.phase)) ||
      dragonExposure(bot, bot.entity.position) > 0 || incomingDragonFireballs(bot).length > 0 || perchedDragonContact(bot, bot.entity.position) ||
      !permitsHide(policy.combat, recoveryAvailable(bot, policy.food))) return false;
    const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    if (!fullProtectionBlock(floor) || !DRAGON_PROTECTION_BLOCKS.includes(floor!.name)) return false;
    // A solid ordinary scaffold cannot be replaced by a resistant wall. Do
    // not spend the retreat building a partial enclosure that cannot close.
    const origin = bot.entity.position.floored();
    if (protectionShell(origin, [origin]).some(cell => {
      const block = bot.blockAt(cell);
      return !(fullProtectionBlock(block) && DRAGON_PROTECTION_BLOCKS.includes(block!.name)) &&
        !isReplaceableForPlacement(block) && block?.name !== "fire";
    })) return false;
    return enclosedInPlace(bot, DRAGON_PROTECTION_BLOCKS) ||
      (policy.combat.terrain.place && countCapBlocks(bot, DRAGON_PROTECTION_BLOCKS) >= WALL_IN_BLOCKS);
  }

  private result(outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult {
    return { outcome, reason, attacks: 0, healthBefore: null, healthAfter: null };
  }

  private async tick(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.bot.health <= 0) throw new Error("Bot died during End combat");
    if (this.footing.needed) await this.footing.recover(signal);
    await waitForPhysicsTicks(this.bot, 1, signal);
  }

  /** One flight shot from the current footing; no perch preparation or tower chase. */
  async shootDragon(signal: AbortSignal, observation: DragonShotObservation): Promise<EndCombatResult> {
    const bot = this.bot;
    const finish = (outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult => {
      observation.phase = "settled";
      return { outcome, reason, attacks: observation.attacks, healthBefore: observation.healthBefore,
        healthAfter: observation.healthAfter, bow: observation.evidence };
    };
    const unavailable = () => {
      if (!this.policy().combat.bow) return "[COMBAT_CONSTRAINED] Bow use is prohibited.";
      if (!selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.policy().combat)))
        return "[DRAGON_BOW_UNAVAILABLE] Carry a permitted bow and arrows before shooting.";
      return null;
    };
    // The body pose does not require unsent head/neck flight history. Lead its
    // centre from observed motion; the parent's 16-wide box is not a hitbox.
    const aim = () => {
      const dragon = observation.target!, velocity = observation.velocity, previousVelocity = observation.previousVelocity;
      if (!velocity || !previousVelocity) { observation.blockedBy = "Waiting for fresh dragon motion."; return null; }
      const target = dragon.position.offset(Math.sin(dragon.yaw) * 0.5, 1.5, Math.cos(dragon.yaw) * 0.5);
      if (bot.entity.position.distanceTo(target) > 64) {
        observation.blockedBy = "Dragon is beyond the 64-block firing range; move closer or wait for its next pass.";
        return null;
      }
      const trajectory = bowTrajectory(this.eyePosition().offset(0, -0.1, 0), target, velocity);
      if (!trajectory || !clearBowTrajectory(trajectory, (p, d, n) => bot.world.raycast(p, d, n))) {
        observation.blockedBy = "No clear intercept from this footing; wait for a pass or move to an exposed position.";
        return null;
      }
      if (!fitsDragonShot(trajectory.points.at(-1)!, target, velocity, previousVelocity,
          trajectory.flightTicks, observation.hitboxMargin)) {
        observation.blockedBy = "Dragon motion leaves the inset body estimates; holding the arrow for a steadier or closer pass.";
        return null;
      }
      const yaw = Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z);
      const pitch = Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z));
      if (endermanGazeRisk(bot, bot.entity.position, yaw, pitch)) {
        observation.blockedBy = "An Enderman obstructs the safe aim direction.";
        return null;
      }
      observation.blockedBy = null;
      return { trajectory, yaw, pitch };
    };
    const use = new CombatItemUse(bot, async ticks => { for (let i = 0; i < ticks; i++) await this.tick(signal); });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (observation.died) return finish("dragon_died");
        if (!observation.loaded) return finish("stopped", "Selected dragon is no longer loaded in the original dimension; disappearance is not a kill.");
        // Reconcile a released arrow before checking equipment or firing again,
        // including when a hostile reflex consumed the whole observation window.
        if (observation.attacks > 0) {
          if (observation.damageObserved > 0) {
            this.execution.progress.confirmedHit(true);
            return finish("dragon_damaged", "Dragon health decreased after the shot; this observation does not identify damage from other players.");
          }
          if (observation.remainingFlightTicks <= 0)
            return finish("shot_missed", "No dragon health loss observed after the released arrow. Its turn, terrain or a perch transition may have prevented damage.");
        } else {
          const refusal = unavailable();
          if (refusal) return finish("weapon_unavailable", refusal);
          if (isDragonPerched(observation.nativePhase))
            return finish("stopped", "[DRAGON_PERCHED] A sitting dragon is immune to arrows. Use attack_dragon_perch or wait for takeoff.");
          if (observation.nativePhase === null || observation.nativePhase === 9)
            return finish("stopped", "Dragon flight is not available for a bow shot; inspect its phase again.");
          if (observation.aimingTicks >= 200)
            return finish("stopped", `[DRAGON_SHOT_BLOCKED] ${observation.blockedBy ?? "No safe flight shot opened within 200 aiming ticks."}`);
        }
        const response = decideEndResponse(this.policy().combat, this.danger, "bow");
        if (response.kind === "constrained") return finish("stopped", response.reason);
        if (response.kind === "evade") {
          const escaped = await this.evade(signal);
          if (escaped.outcome !== "evaded") return finish("stopped", escaped.reason);
          continue;
        }
        if (observation.attacks > 0) { await this.phase("observe_shot", () => this.tick(signal)); continue; }
        await this.settle(signal);
        if (!aim()) { observation.aimingTicks++; await this.tick(signal); continue; }
        await equipCombatLoadout(bot, selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.policy().combat))!);
        await this.phase("shoot", async () => {
          using draw = use.drawBow();
          // Re-aim throughout the charge; a flying dragon moves tens of blocks
          // during a full draw. Revalidate again at release, after the last tick.
          for (let tick = 0; tick <= 21; tick++) {
            if (!observation.loaded || observation.died || this.danger || this.footing.needed ||
                isDragonPerched(observation.nativePhase) || observation.nativePhase === 9 || unavailable()) return;
            const shot = aim();
            if (!shot) return;
            await bot.look(shot.yaw, shot.pitch, true);
            signal.throwIfAborted();
            if (!observation.loaded || observation.died || this.danger || this.footing.needed ||
                isDragonPerched(observation.nativePhase) || observation.nativePhase === null ||
                observation.nativePhase === 9 || unavailable()) return;
            if (tick === 21) { observation.released(shot.trajectory.flightTicks); draw.release(); return; }
            observation.aimingTicks++;
            await this.tick(signal);
          }
        });
      }
    } finally {
      await use.neutralise(async () => { if (!signal.aborted) await this.settle(signal); }, signal);
    }
  }

  /** A takeoff hit can arrive between the last swing and the next route.
   * Navigation requires supported admission; settle the observed airborne
   * body, using the existing recovery owner whenever its landing needs work. */
  private async settle(signal: AbortSignal): Promise<void> {
    while (!this.supported) await this.tick(signal);
    if (this.footing.needed) await this.footing.recover(signal);
  }

  private get supported(): boolean {
    return (
      this.bot.entity.onGround ||
      Reflect.get(this.bot.entity, "isInWater") === true ||
      CLIMBABLES.has(this.bot.blockAt(this.bot.entity.position)?.name ?? "")
    );
  }

  /** A long perch call owns the body while the ordinary hunger reflex waits.
   * Keep regeneration available, but release eating immediately for danger. */
  private async eatForRegeneration(signal: AbortSignal): Promise<string | null> {
    if (this.policy().combat.recover === "never") return null;
    if (this.bot.food >= REGENERATION_HUNGER || this.danger) return null;
    const food = selectPolicyFood(this.bot, this.policy().food).food;
    if (!food) return null;
    const danger = new AbortController();
    const observe = () => {
      if (!danger.signal.aborted && (this.danger || this.footing.needed)) {
        danger.abort("End defense interrupted eating");
        if (this.bot.usingHeldItem) this.bot.deactivateItem();
      }
    };
    this.bot.on("physicsTick", observe);
    try {
      const result = await this.phase("recover", () =>
        eatFood(this.bot, { foodName: food.name }, { signal: AbortSignal.any([signal, danger.signal]) }),
      );
      signal.throwIfAborted();
      return result.status === "failed" && !danger.signal.aborted ? result.error : null;
    } catch (error) {
      signal.throwIfAborted();
      if (danger.signal.aborted) return null;
      throw error;
    } finally {
      this.bot.off("physicsTick", observe);
    }
  }

  /** Head approach and breath escape share observed body contact. Only a head
   * approach rejects breath cells: escape can begin inside one and must leave. */
  private movements(routeClouds: ReturnType<typeof readDragonBreathHazards> = []): MovementPolicy {
    const base = createMovements(this.bot, {
      allowParkour: false,
      allowSprinting: false,
      allowDigging: this.policy().combat.terrain.dig,
      scaffolding: this.policy().combat.terrain.place,
    });
    const contact = observeDragonEscape(this.bot);
    return {
      ...base,
      get scaffold() {
        return base.scaffold;
      },
      decideStep(x, y, z, world) {
        const feet = new Vec3(x + 0.5, y, z + 0.5);
        if (routeClouds.some((cloud) => cloudExposure(cloud, feet) > 0))
          return { kind: "prohibited", reason: "Observed dragon breath exposure" };
        // Enforce actual contact volumes. A blanket low ceiling across twelve
        // blocks excluded every reachable stance when the head sat a fraction
        // too high above a breath cloud, including clear positions to its side.
        if (contact.contactAt(feet))
          return { kind: "prohibited", reason: "Perched dragon head, neck or wing contact" };
        return base.decideStep(x, y, z, world);
      },
      decideMovement(kind, from, to) {
        if (to.y < from.y) {
          const dx = to.x - from.x, dz = to.z - from.z;
          const lengthSquared = dx * dx + dz * dz;
          for (const cloud of routeClouds) {
            const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
              ((cloud.x - from.x - 0.5) * dx + (cloud.z - from.z - 0.5) * dz) / lengthSquared));
            if (cloudExposure(cloud, { x: from.x + 0.5 + dx * t, y: to.y, z: from.z + 0.5 + dz * t }, from.y - to.y) > 0)
              return { kind: "prohibited", reason: "Descent would pass through observed dragon breath" };
          }
        }
        if (!["step_up", "pillar", "jump", "sprint_jump", "parkour"].includes(kind)) return { kind: "allowed" };
        // Reserve the jump envelope for transitions that actually jump. A
        // standing/level tunnel walk below breath does not rise 1.3 blocks.
        const dx = to.x - from.x, dz = to.z - from.z;
        const lengthSquared = dx * dx + dz * dz;
        for (const cloud of routeClouds) {
          const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
            ((cloud.x - from.x - 0.5) * dx + (cloud.z - from.z - 0.5) * dz) / lengthSquared));
          if (cloudExposure(cloud, { x: from.x + 0.5 + dx * t, y: from.y, z: from.z + 0.5 + dz * t }, 1.3) > 0)
            return { kind: "prohibited", reason: "Jump would enter observed dragon breath" };
        }
        for (const t of [0, 0.5, 1])
          if (contact.contactAt(new Vec3(from.x + 0.5 + dx * t, from.y + 1.3, from.z + 0.5 + dz * t)))
            return { kind: "prohibited", reason: "Jump would enter perched dragon contact" };
        return { kind: "allowed" };
      },
    };
  }

  /** Locally interrupt a route when defense or a phase change makes it obsolete. */
  private async move(
    goal: Goal,
    signal: AbortSignal,
    obsolete: () => boolean = () => this.danger,
    movements: MovementPolicy = this.movements(),
    maximumMs?: number,
  ): Promise<EndMoveResult> {
    return this.phase("approach", () => this.moveBody(goal, signal, obsolete, movements, maximumMs));
  }

  private async moveBody(
    goal: Goal,
    signal: AbortSignal,
    obsolete: () => boolean,
    movements: MovementPolicy,
    maximumMs?: number,
  ): Promise<EndMoveResult> {
    await this.settle(signal);
    if (obsolete()) return { kind: "changed" };
    const stop = new AbortController();
    const watch = () => {
      if (obsolete() || this.footing.needed) stop.abort("End combat observations changed");
    };
    this.bot.on("physicsTick", watch);
    try {
      const result = await this.navigation.navigate({
        goal,
        movements,
        signal,
        stopSignal: stop.signal,
        stepField: null,
        ...(maximumMs !== undefined ? { timeoutMs: Math.max(1, maximumMs) } : {}),
      });
      signal.throwIfAborted();
      if (!this.supported) {
        await this.settle(signal);
        return { kind: "changed" };
      }
      if (stop.signal.aborted) return { kind: "changed" };
      return result.status === "completed" ? { kind: "arrived" } : { kind: "failed", reason: result.reason };
    } finally {
      this.bot.off("physicsTick", watch);
    }
  }

  async crystal(targetId: number, signal: AbortSignal, observation: CrystalObservation): Promise<EndCombatResult> {
    const bot = this.bot;
    if (bot.game.dimension !== observation.dimension)
      return this.crystalResult(observation, "stopped", "Dimension changed during this crystal request.");
    const loadedTarget = bot.entities[targetId];
    if (loadedTarget && loadedTarget !== observation.target && !observation.destroyed)
      return this.crystalResult(observation, "stopped", "The selected crystal identity is no longer observed.");
    // A released arrow and its receipts survive body takeovers. Never fire a
    // second arrow simply because the first attempt yielded to a reflex.
    if (observation.meleeReturn) return this.climbToCrystal(signal, observation);
    if (observation.destroyed || observation.shot) return this.observeCrystalShot(observation, signal);
    const target = bot.entities[targetId];
    if (!target?.isValid || target.name !== "end_crystal")
      return this.crystalResult(observation, "stopped", "Selected end crystal is not loaded");
    const rangedAvailable = () =>
      selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.policy().combat)) !== null &&
      bot.inventory.items().some((i) => i.name === "arrow");
    if (observation.usedWeapon === null) {
      if (observation.weapon === "bow") {
        if (!this.policy().combat.bow)
          return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Bow use is prohibited.");
        if (!rangedAvailable())
          return this.crystalResult(
            observation,
            "weapon_unavailable",
            "[CRYSTAL_BOW_UNAVAILABLE] Explicit bow requires a permitted carried bow and at least one arrow.",
          );
        observation.usedWeapon = "bow";
        observation.phase = "approaching";
      } else if (observation.weapon === "melee" || !rangedAvailable()) {
        observation.beginMelee();
        return this.climbToCrystal(signal, observation);
      } else {
        observation.usedWeapon = "bow";
        observation.phase = "approaching";
      }
    }
    if (observation.usedWeapon === "melee") return this.climbToCrystal(signal, observation);
    if (!this.policy().combat.bow)
      return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Bow use is prohibited.");
    const aim = target.position.offset(0, 1.75, 0);
    // A power-six crystal explosion reaches twelve blocks. Keep the firing
    // body beyond that radius rather than relying on unverified blast cover.
    const canShoot = (feet: Vec3) => {
      const distance = feet.distanceTo(target.position);
      if (
        distance < 13 ||
        distance >= EXPLOSION_RECEIPT_RANGE ||
        dragonExposure(bot, feet) > 0 ||
        perchedDragonContact(bot, feet)
      )
        return false;
      // Vanilla arrows start one tenth below the eyes. The lower parallel ray
      // leaves clearance for spread: native high shots otherwise clipped the
      // pillar's upper edge even with a nominally clear center trajectory.
      const trajectory = bowTrajectory(feet.offset(0, 1.52, 0), aim);
      return (
        trajectory !== null &&
        !endermanGazeRisk(
          bot,
          feet,
          Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z),
          Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z)),
        ) &&
        clearBowTrajectory(trajectory, (p, d, n) => {
          const hit = bot.world.raycast(p, d, n);
          if (hit) return hit;
          // A full block is a pillar ledge; narrow cage bars still use their
          // actual shape, since inflating them would close every firing slit.
          return bot.world.raycast(p.offset(0, -0.5, 0), d, n, (block) =>
            block.shapes.some((s) => s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1),
          );
        })
      );
    };
    const use = new CombatItemUse(bot, async (ticks) => {
      for (let i = 0; i < ticks; i++) await this.tick(signal);
    });
    // A route ends within its cell, not at its exact center. Remember a cell
    // whose actual arrival lost the narrow cage sightline so the next search
    // must choose a different firing stance instead of returning there forever.
    const unusableStances = new Set<string>();
    try {
      for (;;) {
        signal.throwIfAborted();
        if (observation.destroyed) return this.observeCrystalShot(observation, signal);
        if (!target.isValid) return this.crystalResult(observation, "stopped", "Selected crystal is no longer observed");
        const response = decideEndResponse(this.policy().combat, this.danger, "crystal");
        if (response.kind === "constrained") return this.crystalResult(observation, "stopped", response.reason);
        if (!rangedAvailable()) {
          if (observation.weapon === "auto") {
            observation.beginMelee();
            return await this.climbToCrystal(signal, observation);
          }
          return this.crystalResult(
            observation,
            "weapon_unavailable",
            "[CRYSTAL_BOW_UNAVAILABLE] Explicit bow requires a permitted carried bow and at least one arrow.",
          );
        }
        if (response.kind === "evade") {
          const escaped = await this.evade(signal);
          if (escaped.outcome !== "evaded") return this.crystalResult(observation, "stopped", escaped.reason);
        }
        const foodFailure = await this.eatForRegeneration(signal);
        if (foodFailure) return this.crystalResult(observation, "stopped", foodFailure);
        while (!canShoot(bot.entity.position)) {
          // Give navigation actual firing openings to approach, rather than
          // the tower itself. Reachability remains the pathfinder's decision.
          const openings = bot.findBlocks({
            matching: block => block.boundingBox === "block",
            useExtraInfo: block => {
              const feet = block.position.offset(0, 1, 0);
              return !unusableStances.has(`${feet.x},${feet.y},${feet.z}`) &&
                standingCell(this.navigation.world, feet) && canShoot(feet.offset(0.5, 0, 0.5));
            },
            // Include the far side of the target's observable firing area,
            // even when the bot starts across the island from this tower.
            maxDistance: bot.entity.position.distanceTo(target.position) + EXPLOSION_RECEIPT_RANGE, count: 32,
          }).map(floor => floor.offset(0, 1, 0));
          const goal: Goal = {
            resolve: () => ({
              kind: "active",
              revision: `crystal-shot:${targetId}`,
              // With no sampled opening, keep searching reachable cells.
              heuristic: ({ feet }) => openings.length === 0 ? 0 : Math.min(...openings.map(cell =>
                Math.hypot(feet.x - cell.x, feet.y - cell.y, feet.z - cell.z))),
              isSatisfied: ({ feet }) =>
                !unusableStances.has(`${feet.x},${feet.y},${feet.z}`) &&
                canShoot(new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)),
            }),
          };
          const stopped = await this.move(goal, signal, () => this.danger || !target.isValid || observation.destroyed);
          if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
          if (stopped.kind !== "arrived") {
            if (this.danger) {
              const escaped = await this.evade(signal);
              if (escaped.outcome !== "evaded") return this.crystalResult(observation, "stopped", escaped.reason);
            } else if (stopped.kind === "failed") return this.crystalResult(observation, "stopped", stopped.reason);
          }
          await this.tick(signal);
          if (stopped.kind === "arrived" && !canShoot(bot.entity.position)) {
            const feet = bot.entity.position.floored();
            unusableStances.add(`${feet.x},${feet.y},${feet.z}`);
          }
        }
        const loadout = selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.policy().combat));
        if (!loadout || !bot.inventory.items().some((i) => i.name === "arrow")) continue;
        await equipCombatLoadout(bot, loadout);
        if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
        const trajectory = bowTrajectory(bot.entity.position.offset(0, 1.52, 0), aim);
        if (!trajectory)
          return this.crystalResult(observation, "stopped", "No full-charge arrow trajectory reaches this crystal");
        let interrupted = false;
        const drawn = await this.phase("shoot", async () => {
          using draw = use.drawBow();
          // The use packet can arrive after this client's current physics tick.
          // One extra tick ensures the server has the full twenty-tick draw.
          for (let ticks = 0; ticks < 21; ticks++) {
            if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
            if (this.danger || !canShoot(bot.entity.position)) {
              interrupted = true;
              break;
            }
            await bot.look(
              Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z),
              Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z)),
              true,
            );
            await this.tick(signal);
          }
          if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
          if (!interrupted && (this.danger || !canShoot(bot.entity.position))) interrupted = true;
          if (!interrupted) {
            observation.phase = "aiming";
            observation.released(trajectory.points.length - 1);
            observation.beginBlastObservation();
            draw.release();
          }
        });
        if (drawn) return drawn;
        if (interrupted) continue;
        break;
      }
    } finally {
      await use.neutralise(async () => {
        if (!signal.aborted) await this.settle(signal);
      }, signal);
    }
    // Keep request listeners alive through item cleanup and reconcile AFTER it.
    return this.observeCrystalShot(observation, signal);
  }

  private async observeCrystalShot(observation: CrystalObservation, signal: AbortSignal): Promise<EndCombatResult> {
    observation.beginBlastObservation();
    return this.phase("observe_shot", () => this.reconcileCrystalShot(observation, signal));
  }

  private async reconcileCrystalShot(observation: CrystalObservation, signal: AbortSignal): Promise<EndCombatResult> {
    while (!observation.destroyed && observation.shot && !observation.shot.settled) {
      signal.throwIfAborted();
      if (this.bot.game.dimension !== observation.dimension)
        return this.crystalResult(observation, "stopped", "Dimension changed while observing the crystal shot");
      if (this.danger) {
        const escape = await this.evade(signal);
        if (escape.outcome !== "evaded") return this.crystalResult(observation, "stopped", escape.reason);
      }
      await this.tick(signal);
    }
    signal.throwIfAborted();
    let loaded =
      this.bot.game.dimension === observation.dimension &&
      this.bot.entities[observation.targetId] === observation.target &&
      observation.target?.isValid;
    if (!observation.destroyed && !loaded && observation.shot && observation.target) {
      const site = observation.target.position;
      // A native pedestal provides a stable place to revisit after a retreat.
      const pedestal = this.bot.blockAt(site.offset(0, -1, 0));
      if (observation.nativePedestalObserved || pedestal?.name === "bedrock" || pedestal?.name === "obsidian") {
        for (;;) {
          signal.throwIfAborted();
          if (this.bot.game.dimension !== observation.dimension)
            return this.crystalResult(observation, "stopped", "Dimension changed while rechecking the crystal site");
          if (observation.destroyed) break;
          if (this.danger) {
            const escape = await this.evade(signal);
            if (escape.outcome !== "evaded") return this.crystalResult(observation, "stopped", escape.reason);
          }
          const moved = await this.move(nearXzGoal(site, 24), signal,
            () => this.danger || observation.destroyed || this.bot.game.dimension !== observation.dimension);
          if (moved.kind === "failed") { await this.tick(signal); continue; }
          if (moved.kind !== "arrived") continue;
          // Fresh server time after returning allows tracked entities to arrive.
          const age = this.bot.time.age;
          while (this.bot.time.age - age < 40 && !this.danger && !observation.destroyed) await this.tick(signal);
          if (this.danger) continue;
          if (this.bot.game.dimension !== observation.dimension) continue;
          if (observation.destroyed) break;
          if (Math.hypot(this.bot.entity.position.x - site.x, this.bot.entity.position.z - site.z) > 32) continue;
          if (!this.bot.blockAt(site) || !this.bot.blockAt(site.offset(0, -1, 0))) continue;
          const remaining = Object.values(this.bot.entities).some(entity => entity.isValid && entity.name === "end_crystal" && entity.position.distanceTo(site) < 2);
          if (!remaining) {
            observation.destroyed = true;
            observation.phase = "settled";
            return this.crystalResult(observation, "crystal_destroyed", "Returned to the loaded crystal site and verified it empty after fresh server updates.");
          }
          loaded = true;
          break;
        }
      }
    }
    observation.phase = "settled";
    return this.crystalResult(
      observation,
        observation.destroyed ? "crystal_destroyed" : loaded ? "shot_missed" : "stopped",
        observation.destroyed
          ? null
          : loaded
            ? "Crystal remains loaded after the server observed the shot's flight window"
            : "Crystal left observation without a destruction receipt; the shot is unconfirmed",
      );
  }

  private crystalResult(
    observation: CrystalObservation,
    outcome: EndCombatResult["outcome"],
    reason: string | null = null,
  ): EndCombatResult {
    return {
      ...this.result(outcome, reason),
      attacks: observation.attacks,
      crystal: {
        weapon: observation.weapon,
        approach: observation.approach,
        usedWeapon: observation.usedWeapon,
        phase: observation.phase,
        melee: observation.meleeEvidence(),
      },
    };
  }

  private async climbToCrystal(signal: AbortSignal, observation: CrystalObservation): Promise<EndCombatResult> {
    observation.beginMelee();
    if (!this.policy().combat.melee)
      return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
    const bot = this.bot,
      crystal = observation.target;
    if (!crystal || (!crystal.isValid && !observation.destroyed && !observation.shot))
      return this.crystalResult(observation, "stopped", "Selected crystal is no longer observed");
    const start = (observation.meleeReturn ??= bot.entity.position.floored());
    const pedestal = crystal.position.offset(0, -1, 0).floored();
    // Walking and returning preserve the reusable treads; only the builder
    // places the declared staircase, so supply estimates exclude hidden routes.
    // The pillar approach is the exception: its route is the scaffolding, and
    // the descent digs back through it. The tower stays protected either way.
    const pillar = observation.approach === "pillar";
    const movements = () => createMovements(bot, {
      allowDigging: this.policy().combat.terrain.dig, scaffolding: pillar && this.policy().combat.terrain.place,
      protectedCells: new Set([packKey(pedestal.x, pedestal.y, pedestal.z),
        ...(observation.staircase?.tower.map(p => packKey(p.x, p.y, p.z)) ?? []),
        ...(observation.staircase?.cells.filter(cell => cell.blockName !== "air")
          .map(({ position: p }) => packKey(p.x, p.y, p.z)) ?? [])]),
    });
    while (!observation.destroyed && !observation.shot) {
      signal.throwIfAborted();
      if (this.danger) {
        const escape = await this.evade(signal);
        if (escape.outcome !== "evaded") {
          observation.fail("dragon_contact");
          return this.crystalResult(observation, "stopped", escape.reason);
        }
      }
      const foodFailure = await this.eatForRegeneration(signal);
      if (foodFailure) return this.crystalResult(observation, "stopped", foodFailure);
      try { observation.staircase ??= planCrystalStaircase(bot, crystal.position); }
      catch (error) { return this.crystalResult(observation, "stopped", String(error)); }
      if (pillar) {
        const short = pillarShortfall(bot, this.policy(), observation.staircase);
        if (short) return this.crystalResult(observation, "stopped", short);
      } else {
        const built = await this.buildCrystalApproach(observation, signal);
        if (built.kind === "changed") continue;
        if (built.kind === "failed") return this.crystalResult(observation, "stopped", built.reason);
      }
      const moved = await this.move(exactBlockGoal(observation.staircase.stance), signal,
        () => this.danger || !crystal.isValid, movements());
      if (moved.kind === "failed") {
        observation.fail("stance_unreachable");
        return this.crystalResult(observation, "stopped", moved.reason);
      }
      if (!crystal.isValid) return this.crystalResult(observation, "stopped", "Crystal disappeared before the melee attack");
      if (moved.kind === "changed") continue;
      const feet = bot.entity.position.clone();
      const aim = crystalMeleeAim(bot, crystal.position);
      if (!aim) {
        observation.fail("cage_uncleared");
        return this.crystalResult(observation, "stopped", "[CRYSTAL_ATTACK_CORNER_BLOCKED] The staircase is complete but the stance lacks a clear melee hit within reach. Inspect the cage opening before retrying.");
      }
      // An exposed stance on the tower top must leave the body out of the
      // critical band after the blast. A live swing lost 5.7 health against an
      // estimate of 5.3, so the estimate is close rather than pessimistic;
      // the margin covers the body standing off the cell centre.
      const floor = this.policy().combat.critical_health;
      const blastUnsafe = (estimate: ReturnType<typeof crystalBlastEstimate>) =>
        !estimate.covered && bot.health - estimate.damage - CRYSTAL_BLAST_MARGIN <= floor;
      const blast = crystalBlastEstimate(bot, crystal.position, feet);
      if (blastUnsafe(blast)) {
        observation.fail("blast_unsafe");
        return this.crystalResult(observation, "stopped", `[CRYSTAL_BLAST_UNSAFE] The swing stance on the tower top is exposed to the crystal blast: estimated ${blast.damage.toFixed(1)} damage after armor (exposure ${blast.exposure.toFixed(2)}, ${blast.rawDamage} raw) plus a ${CRYSTAL_BLAST_MARGIN} point margin at health ${bot.health} would end at or below critical_health ${floor}. Heal, wear stronger armor, or destroy this crystal with the bow; the tower is not mined for cover.`);
      }
      await bot.lookAt(aim, true);
      // The dragon can move us while aiming. Never swing on a stale stance.
      if (this.danger || !bot.entity.onGround) continue;
      if (!crystalMeleeAim(bot, crystal.position)) continue;
      // Native explosions retain one point of raw damage even at zero exposure.
      if (bot.health <= 1)
        return this.crystalResult(observation, "stopped", "Too little health for the crystal explosion's minimum damage");
      if (!this.policy().combat.melee)
        return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
      const finalBlast = crystalBlastEstimate(bot, crystal.position, bot.entity.position);
      if (blastUnsafe(finalBlast)) continue;
      observation.recordSwing(
        bot.entity.position.floored().equals(observation.staircase.stance),
        bot.entity.position.offset(0, 1.62, 0).distanceTo(aim),
        { cover: crystalBlastCoverCell(bot, crystal.position, bot.entity.position), exposure: finalBlast.exposure, damage: finalBlast.damage },
      );
      observation.released(0);
      observation.beginBlastObservation();
      bot.attack(crystal);
    }
    const receipt = await this.observeCrystalShot(observation, signal);
    if (receipt.outcome !== "crystal_destroyed") return receipt;
    observation.beginReturn();
    for (;;) {
      if (this.danger) {
        const escape = await this.evade(signal);
        if (escape.outcome !== "evaded") {
          observation.fail("dragon_contact");
          return {
            ...this.crystalResult(observation, "stopped", `Crystal destroyed; return interrupted: ${escape.reason}`),
          };
        }
      }
      const descended = await this.move(crystalReturnGoal(start), signal, () => this.danger, movements());
      if (descended.kind === "changed") continue;
      observation.finishReturn(descended.kind === "arrived");
      return descended.kind === "arrived"
        ? this.crystalResult(observation, "crystal_destroyed")
        : this.crystalResult(observation, "stopped", `Crystal destroyed; return route failed: ${descended.reason}`);
    }
  }

  private async buildCrystalApproach(observation: CrystalObservation, signal: AbortSignal): Promise<EndMoveResult> {
    await this.settle(signal);
    const stop = new AbortController();
    const watch = () => {
      if (this.danger || this.footing.needed || !observation.target?.isValid) stop.abort("Crystal staircase interrupted by changing danger or footing");
    };
    this.bot.on("physicsTick", watch);
    try {
      watch();
      if (stop.signal.aborted) return { kind: "changed" };
      const failure = await this.phase("approach", () => buildCrystalStaircase(this.bot, this.navigation,
        this.policy(), observation.staircase!, AbortSignal.any([signal, stop.signal])));
      return failure ? { kind: "failed", reason: failure } : { kind: "arrived" };
    } catch (error) {
      signal.throwIfAborted();
      if (stop.signal.aborted) return { kind: "changed" };
      throw error;
    } finally { this.bot.off("physicsTick", watch); }
  }

  async perch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    return this.phase("wait_perch", () => this.perchWindow(targetId, signal, observation));
  }

  /** Preparation is useful on its own: give the caller its turn back when the
   * passage is ready or the dragon commits to landing. Never swing here. */
  async preparePerch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    this.perchPreparation.restore(observation);
    const dragon = this.bot.entities[targetId];
    for (;;) {
      signal.throwIfAborted();
      if (this.bot.game.dimension !== observation.dimension || !dragon?.isValid || dragon.name !== "ender_dragon" || dragon !== observation.target)
        return this.perchResult(observation, "stopped", "Selected dragon or its dimension is no longer observed.");
      observation.refresh();
      if (observation.died) return this.perchResult(observation, "stopped", "Dragon death was observed; no perch preparation is needed.");
      const phase = dragonPhase(this.bot, dragon);
      if (isDragonLanding(phase) || isDragonPerched(phase))
        return this.perchResult(observation, "perch_approaching", "Dragon landing or perching observed; preparation yielded immediately. Use attack_dragon_perch for the current head; unfinished preparation can resume during flight.");
      if (observation.landingObserved)
        return this.perchResult(observation, "stopped", "[PERCH_PREPARATION_INTERRUPTED] Landing was observed during this preparation, but the dragon has since left that phase. Use view_status before choosing another preparation or attack; this request will not start a second excavation.");
      if (this.danger) {
        observation.stage = "withdrawing";
        const escaped = await this.evade(signal);
        if (escaped.outcome !== "evaded") return this.perchResult(observation, "stopped", escaped.reason);
        continue;
      }
      if (observation.preparationDamaged) {
        if (this.footing.needed) await this.footing.recover(signal);
        return this.perchResult(observation, "stopped", "[PERCH_PREPARATION_DAMAGED] Preparation took damage and reached clear footing. Inspect health, clouds and the partial passage before choosing another route; this action will not repeat the damaging excavation.");
      }
      const changed = () => {
        observation.refresh();
        const current = dragonPhase(this.bot, dragon);
        return observation.preparationDamaged || this.danger || !dragon.isValid || isDragonLanding(current) || isDragonPerched(current);
      };
      const moved = await this.prepareApproach(observation, signal, changed);
      observation.refresh();
      if (observation.preparationDamaged) continue;
      if (moved.kind === "failed") return this.perchResult(observation, "stopped", moved.reason);
      if (observation.landingObserved) continue;
      if (moved.kind !== "arrived" || this.danger) continue;
      return this.perchResult(observation, "perch_ready", "The low staging notch has an open sightline and a physically traversed short ascent and return without digging or placing. The selected site is retained across calls; recheck current head and clouds before attacking.");
    }
  }

  private cloudedPassage(cell: Vec3, clouds = readDragonBreathHazards(this.bot)): string | null {
    const cloud = clouds.find((hazard) => cloudExposure(hazard, cell.offset(0.5, 0, 0.5), 1.3) > 0);
    return cloud
      ? `[PERCH_PASSAGE_CLOUDED] Dragon breath #${cloud.id} at ${cloud.x.toFixed(1)}, ${cloud.y.toFixed(1)}, ${cloud.z.toFixed(1)} overlaps standing or jump clearance at passage ${cell}. Stay clear and wait for cloud clearance before retrying preparation, or choose another route. A tunnel can contain breath.`
      : null;
  }

  /** Prepare during flight only. Active head pursuit and withdrawal never call this excavation. */
  private async prepareApproach(
    observation: PerchObservation,
    signal: AbortSignal,
    changed: () => boolean,
  ): Promise<EndMoveResult> {
    if (observation.preparationTarget === null) {
      const center = observedDragonLandingCenter(this.bot);
      if (!center)
        return { kind: "failed", reason: "[END_FOUNTAIN_NOT_OBSERVED] Move within loaded view of the exit fountain before preparing a perch approach." };
      const y = Math.floor(center.y) - 7;
      const x = Math.floor(center.x);
      const z = Math.floor(center.z);
      const candidates = [new Vec3(x + 6, y, z), new Vec3(x - 6, y, z), new Vec3(x, y, z + 6), new Vec3(x, y, z - 6)];
      candidates.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(this.bot.entity.position) - b.offset(0.5, 0, 0.5).distanceTo(this.bot.entity.position));
      observation.preparationTarget = candidates[0]!;
    }
    this.perchPreparation.retain(observation);
    observation.stage = "preparing";
    observation.blockedBy = "Preparing a low passage before the head is available.";
    const clouds = readDragonBreathHazards(this.bot);
    const approachChanged = () => changed() || JSON.stringify(readDragonBreathHazards(this.bot)) !== JSON.stringify(clouds);
    const blocked = this.cloudedPassage(observation.preparationTarget, clouds);
    if (blocked) {
      observation.blockedBy = blocked;
      return { kind: "failed", reason: blocked };
    }
    const center = observedDragonLandingCenter(this.bot);
    if (!center)
      return { kind: "failed", reason: "[END_FOUNTAIN_NOT_OBSERVED] The exit fountain left loaded view before its staging sightline was opened." };
    // Open the small rim above the notch, including one extra row toward the
    // fountain. Native avoidance shifted the bot across that inner edge before
    // first scan; the adjacent roof then hid an otherwise prepared stance.
    const notch = observation.preparationTarget;
    const innerX = Math.sign(Math.floor(center.x) - notch.x);
    const innerZ = Math.sign(Math.floor(center.z) - notch.z);
    const outwardX = -innerX, outwardZ = -innerZ;
    const travel = this.perchMovements(clouds);
    // Cut from the surface downward, leaving the preceding tread available
    // for escape instead of dropping into a shaft before building its exit.
    const stairs = [3, 2, 1, 0].map(step => notch.offset(outwardX * step, step, outwardZ * step));
    const descent = stairs.every(cell => standingCell(this.navigation.world, cell)) ? [notch] : stairs;
    for (const destination of descent) {
      const clouded = this.cloudedPassage(destination, clouds);
      if (clouded) return { kind: "failed", reason: clouded };
      const moved = await this.move(exactBlockGoal(destination), signal, approachChanged,
        { ...travel, maximumDrop: 1, allowPlacing: false, scaffold: null });
      if (moved.kind !== "arrived") return moved;
    }
    for (let y = notch.y + 2; y <= Math.floor(center.y) - 3; y++)
      for (let x = notch.x - 1 + Math.min(0, innerX); x <= notch.x + 1 + Math.max(0, innerX); x++)
        for (let z = notch.z - 1 + Math.min(0, innerZ); z <= notch.z + 1 + Math.max(0, innerZ); z++) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          if (!block) return { kind: "failed", reason: "[PERCH_WINDOW_NOT_LOADED] Staging rim is not fully observed; reload the surrounding terrain before preparation." };
          if (block.shapes.length === 0) continue;
          observation.blockedBy = `Opening the small staging rim at ${block.position} before the first landing.`;
          const cleared = await this.clearPerchSightline(block.position.offset(0.5, 0.5, 0.5), signal, changed);
          return cleared.kind === "arrived" ? { kind: "changed" } : cleared;
        }
    const eye = this.eyePosition();
    // Open a small arrival window, including lower/higher body-eye positions.
    // Visibility is observable; a native unseen-player cache is not.
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const parentEye = center.offset(dx, 6.8 + dy, dz);
      const ray = parentEye.minus(eye);
      if (this.bot.world.raycast(eye, ray.scaled(1 / ray.norm()), ray.norm()) === null) continue;
      observation.blockedBy = "Opening the staging sightline across the dragon's landing tolerance before its first scanning phase.";
      const cleared = await this.clearPerchSightline(parentEye, signal, changed);
      // One dig is not readiness. Observe the whole window again afterward.
      return cleared.kind === "arrived" ? { kind: "changed" } : cleared;
    }
    // Create an outward staircase from the low notch to head height. A shaft
    // with a viewing opening alone does not provide a reusable sword approach.
    for (let step = 1; step <= 3; step++) {
      observation.blockedBy = "Preparing the short ascent from the staging notch.";
      const destination = notch.offset(outwardX * step, step, outwardZ * step);
      const clouded = this.cloudedPassage(destination);
      if (clouded) {
        observation.blockedBy = clouded;
        return { kind: "failed", reason: clouded };
      }
      const moved = await this.move(exactBlockGoal(destination), signal, approachChanged, travel);
      if (moved.kind !== "arrived") return moved;
    }
    const walking = { ...travel, allowDigging: false, allowPlacing: false, scaffold: null };
    const top = notch.offset(outwardX * 3, 3, outwardZ * 3);
    for (const destination of [notch, top, notch]) {
      observation.blockedBy = "Verifying the short ascent and return without excavation or scaffolding.";
      const moved = await this.move(exactBlockGoal(destination), signal, approachChanged, walking, 4000);
      if (moved.kind !== "arrived") return moved.kind === "failed"
        ? { kind: "failed", reason: `[PERCH_ACCESS_BLOCKED] The staging ascent/return was not traversable within four seconds without construction: ${moved.reason}` }
        : moved;
    }
    observation.stage = "ready";
    observation.preparedPosition = this.bot.entity.position.clone();
    observation.blockedBy = null;
    this.perchPreparation.retain(observation);
    return { kind: "arrived" };
  }

  /** Perch structures must also be usable as dragon-resistant shelter. */
  private perchMovements(clouds: ReturnType<typeof readDragonBreathHazards> = []): MovementPolicy {
    const base = this.movements(clouds);
    const resistant = createMovements(this.bot, {
      protectedScaffoldNames: this.policy().navigation.scaffold_blocks.filter(name => !DRAGON_PROTECTION_BLOCKS.includes(name)),
      scaffolding: this.policy().combat.terrain.place,
    });
    return { ...base, get scaffold() { return resistant.scaffold; } };
  }

  private perchResult(observation: PerchObservation, outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult {
    this.perchPreparation.retain(observation);
    const noDamage = outcome === "perch_ended" && (observation.healthBefore === null || observation.healthAfter === null || observation.healthAfter >= observation.healthBefore);
    return {
      outcome,
      reason: reason ?? (noDamage ? `Perch ended without confirmed dragon damage. ${observation.blockedBy ?? "No reachable strike was confirmed; inspect the head and prepare a low approach before the next landing."}` : null),
      attacks: observation.attacks,
      healthBefore: observation.healthBefore,
      healthAfter: observation.healthAfter,
      perch: { preparedPosition: observation.preparedPosition, stage: observation.stage, blockedBy: observation.blockedBy, timing: observation.timing },
    };
  }

  private surfaceEntrance(pocket: Vec3): Vec3 | null {
    const candidates: Vec3[] = [];
    // Preparation can leave an open vertical shaft. Its centre no longer has
    // a surface block; inspect the adjoining lip instead of accepting the
    // underground pocket as its own entrance.
    for (let x = pocket.x - 2; x <= pocket.x + 2; x++)
      for (let z = pocket.z - 2; z <= pocket.z + 2; z++)
        for (let y = pocket.y + 16; y > pocket.y; y--) {
          const floor = new Vec3(x, y, z);
          if (this.bot.blockAt(floor)?.boundingBox !== "block") continue;
          if (this.bot.blockAt(floor.offset(0, 1, 0))?.boundingBox === "empty" &&
              this.bot.blockAt(floor.offset(0, 2, 0))?.boundingBox === "empty")
            candidates.push(floor.offset(0, 1, 0));
          break;
        }
    candidates.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(this.bot.entity.position) - b.offset(0.5, 0, 0.5).distanceTo(this.bot.entity.position));
    return candidates[0] ?? null;
  }

  /** Excavating a sightline must yield just like walking when breath, falling
   * or the observed perch pose makes the current block unsafe to work on. */
  private async clearPerchSightline(point: Vec3, signal: AbortSignal, changed: () => boolean): Promise<EndMoveResult> {
    await this.bot.lookAt(point, true);
    const eye = this.eyePosition();
    const ray = point.minus(eye);
    const length = ray.norm();
    if (length === 0) return { kind: "changed" };
    const obstruction = this.bot.world.raycast(eye, ray.scaled(1 / length), length);
    if (!obstruction) return { kind: "changed" };
    // prismarine-world's declaration describes a bare coordinate result, but
    // WorldSync.raycast returns the loaded Block augmented with `intersect`.
    // Keep that runtime boundary explicit instead of reading its nonexistent
    // declared x/y/z fields.
    const hit = obstruction as typeof obstruction & { position?: Vec3; intersect?: Vec3 };
    if (!hit.position || !hit.intersect)
      return { kind: "failed", reason: "[PERCH_RAYCAST_INVALID] The sightline ray did not identify a loaded block position and intersection; reload the staging terrain before digging." };
    const obstructionPosition = hit.position;
    const distance = eye.distanceTo(hit.intersect);
    if (distance > 4.5)
      return { kind: "failed", reason: `[PERCH_SIGHTLINE_OUT_OF_REACH] Obstruction at ${obstructionPosition} intersects the sightline ${distance.toFixed(2)} blocks from the eye, beyond the 4.50 block digging reach. Move closer before clearing it.` };
    const stop = new AbortController();
    const watch = () => { if (changed() || this.footing.needed) stop.abort("Perch excavation observations changed"); };
    this.bot.on("physicsTick", watch);
    try {
      watch();
      if (stop.signal.aborted) return { kind: "changed" };
      const dug = await this.navigation.breakBlockInPlace({
        position: obstructionPosition,
        movements: this.movements(),
        signal: AbortSignal.any([signal, stop.signal]),
      });
      return dug.status === "broken" ? { kind: "arrived" } : { kind: "failed", reason: dug.reason };
    } catch (error) {
      signal.throwIfAborted();
      if (stop.signal.aborted) return { kind: "changed" };
      throw error;
    } finally {
      this.bot.off("physicsTick", watch);
    }
  }

  private eyePosition(): Vec3 {
    const entity = this.bot.entity as Bot["entity"] & { eyeHeight?: number };
    return entity.position.offset(0, entity.eyeHeight ?? 1.62, 0);
  }

  // TODO(dragon combat): revisit after the 2026-09-14 qualification (one full
  // win, one 20-minute timeout with 32 dragon HP; evidence in
  // private/dragon-end-to-end-20260914/REVIEW.md). Start with decision telemetry:
  // identify native perch windows across request retries and record changed
  // reasons for not swinging (reach, stance height, visibility, cooldown,
  // hazards, route failure), with the observed facts and estimated head pose.
  // Then extract sense -> pure typed decision -> interruptible effect from
  // this loop, keeping native dragon phase separate from bot activity. Reuse
  // CombatExecution/reporting and existing movement/building primitives; feed
  // observed dragon damage into shared progress. Preserve behavior first,
  // then use the evidence to improve staging/head approach and verify native
  // full fights. Avoid a new general state-machine framework or crystal rewrite.
  private async perchWindow(
    targetId: number,
    signal: AbortSignal,
    observation: PerchObservation,
  ): Promise<EndCombatResult> {
    const bot = this.bot,
      dragon = bot.entities[targetId];
    this.perchPreparation.restore(observation);
    const use = new CombatItemUse(bot, async (ticks) => {
      for (let i = 0; i < ticks; i++) await this.tick(signal);
    });
    const finish = (outcome: EndCombatResult["outcome"], reason: string | null = null) => this.perchResult(observation, outcome, reason);
    let waitingRouteRevision: string | null = null;
    const targeting: { blockedHeadRoute: { head: Vec3; clouds: string; reason: string } | null } = { blockedHeadRoute: null };
    let blockedBodyRoute: string | null = null;
    let selectedPart: Parameters<Bot["attack"]>[0] | null = null;
    observation.refresh();
    if (observation.died) return finish("dragon_died");
    if (bot.game.dimension !== observation.dimension)
      return finish("stopped", "Dimension changed during this perch request.");
    if (!dragon?.isValid || dragon.name !== "ender_dragon" || dragon !== observation.target)
      return finish("stopped", "Selected dragon is not loaded");
    // Report branch decisions, plus a heartbeat while an awaited route/dig is
    // pending. These observations never participate in movement decisions.
    let diagnostic = { reason: "starting", decidedAtMs: Date.now(), details: {} as Facts };
    let reportedReason: string | null = null, reportedAt = 0;
    const point = (p: Vec3) => ({ x: p.x, y: p.y, z: p.z });
    const emitDiagnostic = () => {
      const now = Date.now();
      if (reportedReason === diagnostic.reason && now - reportedAt < 2000) return;
      reportedReason = diagnostic.reason;
      reportedAt = now;
      const head = perchedDragonHead(bot, dragon);
      this.recordDecision({ boundary: "dragon_perch", targetId, atMs: now,
        ...diagnostic, stage: observation.stage, lastBlockerText: observation.blockedBy,
        feet: point(bot.entity.position), grounded: bot.entity.onGround, health: bot.health,
        nativePhase: dragonPhase(bot, dragon), dragonHealth: entityHealth(bot, dragon), dragonPosition: point(dragon.position),
        estimatedHead: head ? point(head.position) : null,
        selectedPart: selectedPart ? { id: selectedPart.id, name: selectedPart.name ?? null, position: point(selectedPart.position),
          eyeDistance: meleeDistance(bot, selectedPart) } : null,
        fallbackReason: targeting.blockedHeadRoute?.reason ?? null,
        eyeToHeadDistance: head ? meleeDistance(bot, head) : null,
        maximumStrikeY: head ? head.position.y - 2.8 : null,
        cooldownReady: observation.ready, heldItem: bot.heldItem?.name ?? null,
        digPermitted: this.policy().combat.terrain.dig,
        clouds: readDragonBreathHazards(bot).map(c => ({ ...c })),
        currentCloudExposure: dragonExposure(bot, bot.entity.position),
        currentContact: perchedDragonContact(bot, bot.entity.position),
        incomingFireballIds: incomingDragonFireballs(bot).map(e => e.id),
      });
    };
    const report = (reason: string, details: Facts = {}) => {
      diagnostic = { reason, decidedAtMs: Date.now(), details };
      emitDiagnostic();
    };
    bot.on("physicsTick", emitDiagnostic);
    try {
      for (;;) {
        signal.throwIfAborted();
        observation.refresh();
        if (observation.died) return finish("dragon_died");
        if (bot.game.dimension !== observation.dimension)
          return finish("stopped", "Dimension changed during this perch request.");
        if (observation.ended) {
          report("takeoff_withdrawal");
          // Takeoff is an event, not a safe physical handoff. Retain ownership
          // while the existing escape moves below or clear of observed contact.
          const withdrawn = await this.withdrawPerch(observation, signal);
          return withdrawn === null ? finish("perch_ended") : finish("stopped", withdrawn);
        }
        if (!dragon.isValid) return finish("stopped", "Dragon is no longer observed");
        if (bot.health <= 0) return finish("stopped", "Bot died");
        const response = decideEndResponse(this.policy().combat, this.danger, "perch");
        if (response.kind === "constrained") return finish("stopped", response.reason);
        if (this.footing.needed) await this.footing.recover(signal);
        if (response.kind === "evade") {
          report("evading_danger");
          observation.stage = "withdrawing";
          observation.blockedBy = "Dragon cloud, projectile or body contact interrupted the approach; retain retreat and prepare below the danger before the next perch.";
          use.lowerShield();
          const escape = await this.evade(signal);
          if (escape.outcome !== "evaded") return finish("stopped", escape.reason);
          continue;
        }
        const foodFailure = isDragonPerched(dragonPhase(bot, dragon)) && bot.health >= this.policy().combat.engage_min_health
          ? null : await this.eatForRegeneration(signal);
        if (foodFailure) return finish("stopped", foodFailure);
        if (this.danger) continue;
        const head = perchedDragonHead(bot, dragon);
        if (!head) {
          selectedPart = null;
          observation.stage = "waiting";
          const loadout = selectMeleeLoadout(permittedCombatItems(readCombatItems(bot), this.policy().combat));
          const heldBefore = bot.heldItem?.name;
          await equipCombatLoadout(bot, loadout);
          if (heldBefore !== bot.heldItem?.name) observation.resetReadiness(loadout.cooldownTicks);
          // The native final glide can overshoot and reverse its facing. Keep
          // the open low notch until the head is observed; chasing that yaw
          // sent the bot back onto the surface in front of the landing body.
          const belowHead = observation.preparationTarget?.offset(0.5, 0, 0.5);
          const routeRevision = `${dragonPhase(bot, dragon)}:${JSON.stringify(readDragonBreathHazards(bot))}`;
          if (dragonPhase(bot, dragon) !== 1 && belowHead && observation.preparedPosition &&
              waitingRouteRevision !== routeRevision && !this.cloudedPassage(observation.preparationTarget!) && bot.entity.position.distanceTo(belowHead) > 1) {
            waitingRouteRevision = routeRevision;
            report("returning_to_prepared_notch", { destination: point(observation.preparationTarget!) });
            const moved = await this.move(exactBlockGoal(observation.preparationTarget!), signal,
              () => this.danger || !dragon.isValid || perchedDragonHead(bot, dragon) !== null,
              { ...this.perchMovements(), allowDigging: false, allowPlacing: false, scaffold: null });
            if (moved.kind === "failed") {
              observation.blockedBy = `[PERCH_ACCESS_BLOCKED] Cannot return along the prepared passage: ${moved.reason}`;
            }
          }
          // Native strafing does not finish until the dragon can see its
          // target and fire. Remaining in a roofed waiting pocket stalled the
          // physical fight indefinitely. Reuse its surface entrance for this
          // phase, retaining ordinary fireball evasion and the low passage.
          if (dragonPhase(bot, dragon) === 1 && observation.preparationTarget) {
            const entrance = this.surfaceEntrance(observation.preparationTarget);
            if (!entrance) return finish("stopped", "[PERCH_ENTRANCE_NOT_OBSERVED] No loaded surface entrance beside the prepared passage; move to an exposed position so the strafing dragon can see you.");
            observation.stage = "waiting";
            observation.blockedBy = "Giving the strafing dragon a surface sightline before returning to the prepared passage.";
            report(bot.entity.position.floored().equals(entrance) ? "waiting_for_perched_head" : "moving_to_surface_entrance",
              { destination: point(entrance) });
            const moved = await this.move(exactBlockGoal(entrance), signal, () => this.danger || dragonPhase(bot, dragon) !== 1,
              this.perchMovements(readDragonBreathHazards(bot)));
            if (moved.kind === "failed") return finish("stopped", `Cannot reach the passage entrance to end the dragon's strafe: ${moved.reason}`);
          }
          report("waiting_for_perched_head");
          await this.tick(signal);
          continue;
        }
        const routeClouds = readDragonBreathHazards(bot);
        const routeCloudRevision = JSON.stringify(routeClouds);
        if (targeting.blockedHeadRoute && (targeting.blockedHeadRoute.head.distanceTo(head.position) > 0.5 ||
            targeting.blockedHeadRoute.clouds !== routeCloudRevision)) {
          targeting.blockedHeadRoute = null;
          blockedBodyRoute = null;
        }
        const blockHead = (reason: string) => {
          targeting.blockedHeadRoute = { head: head.position.clone(), clouds: routeCloudRevision, reason };
          blockedBodyRoute = null;
        };
        // Keep the same low approach and escape clearance for every part.
        // A blocked head is reconsidered when its pose or cloud geometry changes,
        // not on every step of the fallback route.
        const maximumStrikeY = head.position.y - 2.8;
        const parts = targeting.blockedHeadRoute ? perchedDragonBodyParts(bot, dragon) : [head];
        const contact = observeDragonEscape(bot);
        const safe = (p: Vec3) => p.y <= maximumStrikeY &&
          routeClouds.every(cloud => cloudExposure(cloud, p) === 0) && !contact.contactAt(p);
        const usable = (p: Vec3) => safe(p) && parts.some(part => distanceToBody(p, part) <= 2.95);
        const headMoved = () => {
          const current = perchedDragonHead(bot, dragon);
          return current === null || current.position.distanceTo(head.position) > 0.5;
        };
        const cloudsChanged = () => JSON.stringify(readDragonBreathHazards(bot)) !== routeCloudRevision;
        // Prefer an exposed part already in reach; otherwise navigation searches
        // the union of safe endpoints, so an unreachable nearest part cannot
        // prevent it reaching another part.
        const target = [...parts].sort((a, b) =>
          Number(canMeleeTarget(bot, b)) - Number(canMeleeTarget(bot, a)) || meleeDistance(bot, a) - meleeDistance(bot, b))[0]!;
        selectedPart = target;
        if (meleeDistance(bot, target) > 3 || !safe(bot.entity.position)) {
          observation.stage = "approaching_head";
          const candidates = { scanned: 0, tooHigh: 0, outOfReach: 0, cloudBlocked: 0, contactBlocked: 0, usable: 0 };
          let firstUsable: Facts = null;
          for (const part of parts) {
            const stance = perchAttackCell(part.position), radius = Math.ceil(part.width / 2 + 3);
            for (let x = stance.x - radius; x <= stance.x + radius && !firstUsable; x++)
              for (let z = stance.z - radius; z <= stance.z + radius && !firstUsable; z++)
                for (let y = Math.floor(part.position.y) - 5; y <= Math.floor(part.position.y); y++) {
                  const p = new Vec3(x + 0.5, y, z + 0.5);
                  candidates.scanned++;
                  if (p.y > maximumStrikeY) candidates.tooHigh++;
                  else if (distanceToBody(p, part) > 2.95) candidates.outOfReach++;
                  else if (routeClouds.some(cloud => cloudExposure(cloud, p) > 0)) candidates.cloudBlocked++;
                  else if (contact.contactAt(p)) candidates.contactBlocked++;
                  else { candidates.usable++; firstUsable = point(p); break; }
                }
            if (firstUsable) break;
          }
          if (!firstUsable) {
            if (!targeting.blockedHeadRoute) {
              blockHead("No head stance is clear of breath and contact.");
              report("head_blocked_trying_body", { candidates });
              continue;
            }
            observation.blockedBy = "No safe sword stance for the head or observed body parts; waiting for pose or cloud change.";
            report("no_safe_striking_position", { candidates, planningReach: 2.95 });
            await this.tick(signal);
            continue;
          }
          const bodyRevision = `${head.position}:${routeCloudRevision}:${bot.entity.position.floored()}`;
          if (targeting.blockedHeadRoute && blockedBodyRoute === bodyRevision) {
            report("cached_route_failure", { failure: observation.blockedBy,
              retryWhen: "head moves >0.5 blocks, cloud geometry changes, or feet enter another block" });
            await this.tick(signal);
            continue;
          }
          const goal: Goal = {
            resolve: () => ({
              kind: "active",
              revision: `dragon-${targeting.blockedHeadRoute ? "body" : "head"}:${targetId}:${head.position}`,
              heuristic: ({ feet }) => Math.min(...parts.map(part =>
                Math.max(0, distanceToBody({ x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, part) - 2.95,
                  feet.y - maximumStrikeY))) * 4,
              isSatisfied: ({ feet }) => usable(new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)),
            }),
          };
          const approach = this.perchMovements(routeClouds);
          const routeCeiling = Math.max(Math.floor(bot.entity.position.y), maximumStrikeY);
          observation.blockedBy = `Approaching safe sword reach of ${targeting.blockedHeadRoute ? "another dragon part" : "the head"}.`;
          report(targeting.blockedHeadRoute ? "navigating_to_body" : "navigating_to_head", { candidates,
            targetParts: parts.map(part => part.name ?? null), firstGeometricallyUsablePosition: firstUsable, routeCeiling, planningReach: 2.95 });
          const stop = await this.move(goal, signal, () => this.danger || headMoved() || cloudsChanged(),
            { ...approach,
              get scaffold() { return approach.scaffold; },
              decideMovement(kind, from, to) {
                if (to.y > routeCeiling)
                  return { kind: "prohibited", reason: "Dragon approach must not climb above its low strike route" };
                return approach.decideMovement!(kind, from, to);
              },
            });
          report(targeting.blockedHeadRoute ? "body_route_result" : "head_route_result", { result: stop.kind,
            failure: stop.kind === "failed" ? stop.reason : null, dangerNow: this.danger,
            headChanged: headMoved(), cloudsChanged: cloudsChanged() });
          if (stop.kind === "failed") {
            observation.blockedBy = `[PERCH_ROUTE_BLOCKED] ${stop.reason}`;
            if (!targeting.blockedHeadRoute) blockHead(observation.blockedBy);
            else blockedBodyRoute = `${head.position}:${routeCloudRevision}:${bot.entity.position.floored()}`;
          }
          await this.tick(signal);
          continue;
        }
        const aim = nearestBodyPoint(bot.entity.position.offset(0, 1.62, 0), target);
        if (!canMeleeTarget(bot, target)) {
          observation.blockedBy = `Clearing the observed block between the low stance and ${target.name}.`;
          report("clearing_part_sightline", { aim: point(aim) });
          const dug = await this.clearPerchSightline(aim, signal, () => this.danger || headMoved());
          if (dug.kind === "failed") {
            if (!targeting.blockedHeadRoute) { blockHead(dug.reason); continue; }
            return finish("stopped", dug.reason);
          }
          continue;
        }
        const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(bot, target), this.policy().combat));
        const heldBefore = bot.heldItem?.name;
        await equipCombatLoadout(bot, loadout);
        if (heldBefore !== bot.heldItem?.name) observation.resetReadiness(loadout.cooldownTicks);
        await bot.lookAt(aim, true);
        signal.throwIfAborted();
        observation.refresh();
        if (observation.ended || observation.died || this.danger || headMoved()) continue;
        if (bot.heldItem?.name.endsWith("_sword") && hasSweepBystander(bot, target)) {
          report("sweep_bystander");
          await this.tick(signal);
          continue;
        }
        if (observation.ready) {
          observation.stage = "attacking";
          observation.blockedBy = null;
          if (!this.policy().combat.melee) return finish("stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
          report("swinging");
          await this.phase("swing", async () => {
            bot.attack(target);
            observation.swung(loadout.cooldownTicks);
          });
        } else report("weapon_cooldown");
        await this.tick(signal);
      }
    } finally {
      report("request_releasing");
      bot.off("physicsTick", emitDiagnostic);
      await use.neutralise(async () => {
        if (!signal.aborted) await this.settle(signal);
      }, signal);
    }
  }

  /** A takeoff packet starts withdrawal; a supported, hazard-free interval ends it. */
  private async withdrawPerch(observation: PerchObservation, signal: AbortSignal): Promise<string | null> {
    observation.stage = "withdrawing";
    const deadline = Date.now() + this.policy().combat.evade_timeout_ms;
    let clearTicks = 0;
    let triedPreparedDescent = false;
    while (clearTicks < 10) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) return "[PERCH_RETREAT_INCOMPLETE] Takeoff did not reach stable clear footing within the escape budget.";
      if (this.danger) {
        clearTicks = 0;
        const notch = observation.preparationTarget;
        if (!triedPreparedDescent && notch && observation.preparedPosition) {
          triedPreparedDescent = true;
          const clouds = readDragonBreathHazards(this.bot);
          const destination = notch.offset(0.5, 0, 0.5);
          if (!this.cloudedPassage(notch, clouds) && observeDragonEscape(this.bot).clearAt(destination)) {
            const moved = await this.move(exactBlockGoal(notch), signal,
              () => this.cloudedPassage(notch) !== null,
              { ...this.perchMovements(clouds), allowDigging: false, allowPlacing: false, scaffold: null },
              Math.min(4000, deadline - Date.now()));
            if (moved.kind === "arrived" && !this.danger) continue;
          }
        }
        const escaped = await this.evade(signal);
        if (escaped.outcome !== "evaded") return `[PERCH_RETREAT_INCOMPLETE] ${escaped.reason}`;
      }
      await this.tick(signal);
      clearTicks = !this.danger && this.supported && !this.footing.needed ? clearTicks + 1 : 0;
    }
    observation.handoffComplete = true;
    return null;
  }
}
