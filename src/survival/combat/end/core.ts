import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, type Goal, type NavigationRuntime } from "../../../navigation/index.js";
import { CLIMBABLES } from "../../../navigation/mineflayer/world.js";
import type { MovementPolicy } from "../../../navigation/movements/policy.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { cloudExposure, dragonDanger, dragonExposure, incomingDragonBodies, incomingDragonFireballs, observeDragonEscape, perchedDragonContact, readDragonBreathHazards } from "../../../world/dragon-hazards.js";
import { dragonPhase, isDragonLanding, isDragonPerched } from "../../../world/end-fight.js";
import { REGENERATION_HUNGER } from "../../../world/food.js";
import { selectPolicyFood } from "../../perception/food.js";
import type { CombatExecution, CombatPhase } from "../execution.js";
import type { ResponseContext } from "../../perception/combat/context.js";
import { recoveryAvailable } from "../../perception/combat/recovery.js";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import { PerchPreparation } from "../../perception/combat/perch-preparation.js";
import type { SurvivalPolicy } from "../../policy/contract.js";
import { decideEndResponse } from "../../policy/combat/end-decision.js";
import { permitsHide } from "../../policy/combat/permissions.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import { fullProtectionBlock } from "../../positioning/combat/build-protection.js";
import { countCapBlocks, DRAGON_PROTECTION_BLOCKS } from "../../positioning/combat/hide-blocks.js";
import { protectionShell } from "../../positioning/combat/planner.js";
import { type SurvivalResources } from "../../state/resources.js";
import { FootingRecovery } from "../../responses/footing.js";
import { enclosedInPlace, hideInPlace, WALL_IN_BLOCKS } from "../../responses/hide.js";
import type { Facts } from "../../../utils/facts.js";
import { eatFood } from "../../../world/procedures/eating.js";
import type { CrystalEvidence } from "../../perception/combat/crystal.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";

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
export type EndMoveResult = { kind: "arrived" } | { kind: "changed" } | { kind: "failed"; reason: string };

/** The End fight's shared body: phases, routes around the dragon, and the escape every attack falls back on. */
export class EndCore {
  constructor(
    readonly bot: Bot,
    readonly navigation: NavigationRuntime,
    readonly footing: FootingRecovery,
    readonly policy: () => Readonly<SurvivalPolicy>,
    readonly survival: SurvivalResources,
    readonly execution: CombatExecution,
    readonly threatContext: ResponseContext,
    readonly recordDecision: (evidence: Facts) => void,
    readonly perchPreparation = new PerchPreparation(),
  ) {}

  phase<T>(phase: CombatPhase, effect: () => Promise<T>): Promise<T> {
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

  result(outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult {
    return { outcome, reason, attacks: 0, healthBefore: null, healthAfter: null };
  }

  async tick(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.bot.health <= 0) throw new Error("Bot died during End combat");
    if (this.footing.needed) await this.footing.recover(signal);
    await waitForPhysicsTicks(this.bot, 1, signal);
  }

  /** A takeoff hit can arrive between the last swing and the next route.
   * Navigation requires supported admission; settle the observed airborne
   * body, using the existing recovery owner whenever its landing needs work. */
  async settle(signal: AbortSignal): Promise<void> {
    while (!this.supported) await this.tick(signal);
    if (this.footing.needed) await this.footing.recover(signal);
  }

  get supported(): boolean {
    return (
      this.bot.entity.onGround ||
      Reflect.get(this.bot.entity, "isInWater") === true ||
      CLIMBABLES.has(this.bot.blockAt(this.bot.entity.position)?.name ?? "")
    );
  }

  /** A long perch call owns the body while the ordinary hunger reflex waits.
   * Keep regeneration available, but release eating immediately for danger. */
  async eatForRegeneration(signal: AbortSignal): Promise<string | null> {
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
  movements(routeClouds: ReturnType<typeof readDragonBreathHazards> = []): MovementPolicy {
    return this.avoidingDragon(createMovements(this.bot, {
      allowParkour: false,
      allowSprinting: false,
      allowDigging: this.policy().combat.terrain.dig,
      scaffolding: this.policy().combat.terrain.place,
    }), routeClouds);
  }

  /** Refuse every stance and jump inside the observed perched dragon's
   * head, neck and wing boxes, and in `routeClouds`, on top of `base`. */
  avoidingDragon(base: MovementPolicy, routeClouds: ReturnType<typeof readDragonBreathHazards> = []): MovementPolicy {
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
  async move(
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
}
