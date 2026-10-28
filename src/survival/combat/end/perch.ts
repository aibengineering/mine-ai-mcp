import { standingCell } from "../../positioning/combat/geometry.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, exactBlockGoal, type Goal } from "../../../navigation/index.js";
import type { MovementPolicy } from "../../../navigation/movements/policy.js";
import { cloudExposure, dragonExposure, incomingDragonFireballs, observeDragonEscape, perchedDragonContact, readDragonBreathHazards } from "../../../world/dragon-hazards.js";
import { entityHealth, dragonPhase, isDragonLanding, isDragonPerched, observedDragonLandingCenter, perchAttackCell, perchedDragonHead, perchedDragonBodyParts } from "../../../world/end-fight.js";
import { nearestBodyPoint } from "../../../world/entity-geometry.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import { decideEndResponse } from "../../policy/combat/end-decision.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { DRAGON_PROTECTION_BLOCKS } from "../../positioning/combat/hide-blocks.js";
import { CombatItemUse } from "../../weapons/item-use.js";
import { canMeleeTarget, combatItemsForTarget, hasSweepBystander } from "../../weapons/melee.js";
import type { Facts } from "../../../utils/facts.js";
import { distanceToBody, meleeDistance } from "../../perception/combat/reach.js";
import { equipCombatLoadout, readCombatItems, selectMeleeLoadout } from "../../weapons/equipment.js";
import { EndCore, type EndCombatResult, type EndMoveResult } from "./core.js";

/** Prepares for and fights the dragon's perch: the approach, the window, and the withdrawal. */
export class PerchAttack {
  constructor(private readonly end: EndCore) {}

  async perch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    return this.end.phase("wait_perch", () => this.perchWindow(targetId, signal, observation));
  }

  /** Preparation is useful on its own: give the caller its turn back when the
   * passage is ready or the dragon commits to landing. Never swing here. */
  async preparePerch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    this.end.perchPreparation.restore(observation);
    const dragon = this.end.bot.entities[targetId];
    for (;;) {
      signal.throwIfAborted();
      if (this.end.bot.game.dimension !== observation.dimension || !dragon?.isValid || dragon.name !== "ender_dragon" || dragon !== observation.target)
        return this.perchResult(observation, "stopped", "Selected dragon or its dimension is no longer observed.");
      observation.refresh();
      if (observation.died) return this.perchResult(observation, "stopped", "Dragon death was observed; no perch preparation is needed.");
      const phase = dragonPhase(this.end.bot, dragon);
      if (isDragonLanding(phase) || isDragonPerched(phase))
        return this.perchResult(observation, "perch_approaching", "Dragon landing or perching observed; preparation yielded immediately. Use attack_dragon_perch for the current head; unfinished preparation can resume during flight.");
      if (observation.landingObserved)
        return this.perchResult(observation, "stopped", "[PERCH_PREPARATION_INTERRUPTED] Landing was observed during this preparation, but the dragon has since left that phase. Use view_status before choosing another preparation or attack; this request will not start a second excavation.");
      if (this.end.danger) {
        observation.stage = "withdrawing";
        const escaped = await this.end.evade(signal);
        if (escaped.outcome !== "evaded") return this.perchResult(observation, "stopped", escaped.reason);
        continue;
      }
      if (observation.preparationDamaged) {
        if (this.end.footing.needed) await this.end.footing.recover(signal);
        return this.perchResult(observation, "stopped", "[PERCH_PREPARATION_DAMAGED] Preparation took damage and reached clear footing. Inspect health, clouds and the partial passage before choosing another route; this action will not repeat the damaging excavation.");
      }
      const changed = () => {
        observation.refresh();
        const current = dragonPhase(this.end.bot, dragon);
        return observation.preparationDamaged || this.end.danger || !dragon.isValid || isDragonLanding(current) || isDragonPerched(current);
      };
      const moved = await this.prepareApproach(observation, signal, changed);
      observation.refresh();
      if (observation.preparationDamaged) continue;
      if (moved.kind === "failed") return this.perchResult(observation, "stopped", moved.reason);
      if (observation.landingObserved) continue;
      if (moved.kind !== "arrived" || this.end.danger) continue;
      return this.perchResult(observation, "perch_ready", "The low staging notch has an open sightline and a physically traversed short ascent and return without digging or placing. The selected site is retained across calls; recheck current head and clouds before attacking.");
    }
  }

  private cloudedPassage(cell: Vec3, clouds = readDragonBreathHazards(this.end.bot)): string | null {
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
      const center = observedDragonLandingCenter(this.end.bot);
      if (!center)
        return { kind: "failed", reason: "[END_FOUNTAIN_NOT_OBSERVED] Move within loaded view of the exit fountain before preparing a perch approach." };
      const y = Math.floor(center.y) - 7;
      const x = Math.floor(center.x);
      const z = Math.floor(center.z);
      const candidates = [new Vec3(x + 6, y, z), new Vec3(x - 6, y, z), new Vec3(x, y, z + 6), new Vec3(x, y, z - 6)];
      candidates.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(this.end.bot.entity.position) - b.offset(0.5, 0, 0.5).distanceTo(this.end.bot.entity.position));
      observation.preparationTarget = candidates[0]!;
    }
    this.end.perchPreparation.retain(observation);
    observation.stage = "preparing";
    observation.blockedBy = "Preparing a low passage before the head is available.";
    const clouds = readDragonBreathHazards(this.end.bot);
    const approachChanged = () => changed() || JSON.stringify(readDragonBreathHazards(this.end.bot)) !== JSON.stringify(clouds);
    const blocked = this.cloudedPassage(observation.preparationTarget, clouds);
    if (blocked) {
      observation.blockedBy = blocked;
      return { kind: "failed", reason: blocked };
    }
    const center = observedDragonLandingCenter(this.end.bot);
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
    const descent = stairs.every(cell => standingCell(this.end.navigation.world, cell)) ? [notch] : stairs;
    for (const destination of descent) {
      const clouded = this.cloudedPassage(destination, clouds);
      if (clouded) return { kind: "failed", reason: clouded };
      const moved = await this.end.move(exactBlockGoal(destination), signal, approachChanged,
        { ...travel, maximumDrop: 1, allowPlacing: false, scaffold: null });
      if (moved.kind !== "arrived") return moved;
    }
    for (let y = notch.y + 2; y <= Math.floor(center.y) - 3; y++)
      for (let x = notch.x - 1 + Math.min(0, innerX); x <= notch.x + 1 + Math.max(0, innerX); x++)
        for (let z = notch.z - 1 + Math.min(0, innerZ); z <= notch.z + 1 + Math.max(0, innerZ); z++) {
          const block = this.end.bot.blockAt(new Vec3(x, y, z));
          if (!block) return { kind: "failed", reason: "[PERCH_WINDOW_NOT_LOADED] Staging rim is not fully observed; reload the surrounding terrain before preparation." };
          if (block.shapes.length === 0) continue;
          observation.blockedBy = `Opening the small staging rim at ${block.position} before the first landing.`;
          const cleared = await this.clearPerchSightline(block.position.offset(0.5, 0.5, 0.5), signal, changed);
          return cleared.kind === "arrived" ? { kind: "changed" } : cleared;
        }
    const eye = this.end.bot.entity.position.offset(0, observedEyeHeight(this.end.bot.entity), 0);
    // Open a small arrival window, including lower/higher body-eye positions.
    // Visibility is observable; a native unseen-player cache is not.
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const parentEye = center.offset(dx, 6.8 + dy, dz);
      const ray = parentEye.minus(eye);
      if (this.end.bot.world.raycast(eye, ray.scaled(1 / ray.norm()), ray.norm()) === null) continue;
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
      const moved = await this.end.move(exactBlockGoal(destination), signal, approachChanged, travel);
      if (moved.kind !== "arrived") return moved;
    }
    const walking = { ...travel, allowDigging: false, allowPlacing: false, scaffold: null };
    const top = notch.offset(outwardX * 3, 3, outwardZ * 3);
    for (const destination of [notch, top, notch]) {
      observation.blockedBy = "Verifying the short ascent and return without excavation or scaffolding.";
      const moved = await this.end.move(exactBlockGoal(destination), signal, approachChanged, walking, 4000);
      if (moved.kind !== "arrived") return moved.kind === "failed"
        ? { kind: "failed", reason: `[PERCH_ACCESS_BLOCKED] The staging ascent/return was not traversable within four seconds without construction: ${moved.reason}` }
        : moved;
    }
    observation.stage = "ready";
    observation.preparedPosition = this.end.bot.entity.position.clone();
    observation.blockedBy = null;
    this.end.perchPreparation.retain(observation);
    return { kind: "arrived" };
  }

  /** Perch structures must also be usable as dragon-resistant shelter. */
  private perchMovements(clouds: ReturnType<typeof readDragonBreathHazards> = []): MovementPolicy {
    const base = this.end.movements(clouds);
    const resistant = createMovements(this.end.bot, {
      protectedScaffoldNames: this.end.policy().navigation.scaffold_blocks.filter(name => !DRAGON_PROTECTION_BLOCKS.includes(name)),
      scaffolding: this.end.policy().combat.terrain.place,
    });
    return { ...base, get scaffold() { return resistant.scaffold; } };
  }

  private perchResult(observation: PerchObservation, outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult {
    this.end.perchPreparation.retain(observation);
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
          if (this.end.bot.blockAt(floor)?.boundingBox !== "block") continue;
          if (this.end.bot.blockAt(floor.offset(0, 1, 0))?.boundingBox === "empty" &&
              this.end.bot.blockAt(floor.offset(0, 2, 0))?.boundingBox === "empty")
            candidates.push(floor.offset(0, 1, 0));
          break;
        }
    candidates.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(this.end.bot.entity.position) - b.offset(0.5, 0, 0.5).distanceTo(this.end.bot.entity.position));
    return candidates[0] ?? null;
  }

  /** Excavating a sightline must yield just like walking when breath, falling
   * or the observed perch pose makes the current block unsafe to work on. */
  private async clearPerchSightline(point: Vec3, signal: AbortSignal, changed: () => boolean): Promise<EndMoveResult> {
    await this.end.bot.lookAt(point, true);
    const eye = this.end.bot.entity.position.offset(0, observedEyeHeight(this.end.bot.entity), 0);
    const ray = point.minus(eye);
    const length = ray.norm();
    if (length === 0) return { kind: "changed" };
    const obstruction = this.end.bot.world.raycast(eye, ray.scaled(1 / length), length);
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
    const watch = () => { if (changed() || this.end.footing.needed) stop.abort("Perch excavation observations changed"); };
    this.end.bot.on("physicsTick", watch);
    try {
      watch();
      if (stop.signal.aborted) return { kind: "changed" };
      const dug = await this.end.navigation.breakBlockInPlace({
        position: obstructionPosition,
        movements: this.end.movements(),
        signal: AbortSignal.any([signal, stop.signal]),
      });
      return dug.status === "broken" ? { kind: "arrived" } : { kind: "failed", reason: dug.reason };
    } catch (error) {
      signal.throwIfAborted();
      if (stop.signal.aborted) return { kind: "changed" };
      throw error;
    } finally {
      this.end.bot.off("physicsTick", watch);
    }
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
    const bot = this.end.bot,
      dragon = bot.entities[targetId];
    this.end.perchPreparation.restore(observation);
    const use = new CombatItemUse(bot, async (ticks) => {
      for (let i = 0; i < ticks; i++) await this.end.tick(signal);
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
      this.end.recordDecision({ boundary: "dragon_perch", targetId, atMs: now,
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
        digPermitted: this.end.policy().combat.terrain.dig,
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
        const response = decideEndResponse(this.end.policy().combat, this.end.danger, "perch");
        if (response.kind === "constrained") return finish("stopped", response.reason);
        if (this.end.footing.needed) await this.end.footing.recover(signal);
        if (response.kind === "evade") {
          report("evading_danger");
          observation.stage = "withdrawing";
          observation.blockedBy = "Dragon cloud, projectile or body contact interrupted the approach; retain retreat and prepare below the danger before the next perch.";
          use.lowerShield();
          const escape = await this.end.evade(signal);
          if (escape.outcome !== "evaded") return finish("stopped", escape.reason);
          continue;
        }
        const foodFailure = isDragonPerched(dragonPhase(bot, dragon)) && bot.health >= this.end.policy().combat.engage_min_health
          ? null : await this.end.eatForRegeneration(signal);
        if (foodFailure) return finish("stopped", foodFailure);
        if (this.end.danger) continue;
        const head = perchedDragonHead(bot, dragon);
        if (!head) {
          selectedPart = null;
          observation.stage = "waiting";
          const loadout = selectMeleeLoadout(permittedCombatItems(readCombatItems(bot), this.end.policy().combat));
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
            const moved = await this.end.move(exactBlockGoal(observation.preparationTarget!), signal,
              () => this.end.danger || !dragon.isValid || perchedDragonHead(bot, dragon) !== null,
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
            const moved = await this.end.move(exactBlockGoal(entrance), signal, () => this.end.danger || dragonPhase(bot, dragon) !== 1,
              this.perchMovements(readDragonBreathHazards(bot)));
            if (moved.kind === "failed") return finish("stopped", `Cannot reach the passage entrance to end the dragon's strafe: ${moved.reason}`);
          }
          report("waiting_for_perched_head");
          await this.end.tick(signal);
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
            await this.end.tick(signal);
            continue;
          }
          const bodyRevision = `${head.position}:${routeCloudRevision}:${bot.entity.position.floored()}`;
          if (targeting.blockedHeadRoute && blockedBodyRoute === bodyRevision) {
            report("cached_route_failure", { failure: observation.blockedBy,
              retryWhen: "head moves >0.5 blocks, cloud geometry changes, or feet enter another block" });
            await this.end.tick(signal);
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
          const stop = await this.end.move(goal, signal, () => this.end.danger || headMoved() || cloudsChanged(),
            { ...approach,
              get scaffold() { return approach.scaffold; },
              decideMovement(kind, from, to) {
                if (to.y > routeCeiling)
                  return { kind: "prohibited", reason: "Dragon approach must not climb above its low strike route" };
                return approach.decideMovement!(kind, from, to);
              },
            });
          report(targeting.blockedHeadRoute ? "body_route_result" : "head_route_result", { result: stop.kind,
            failure: stop.kind === "failed" ? stop.reason : null, dangerNow: this.end.danger,
            headChanged: headMoved(), cloudsChanged: cloudsChanged() });
          if (stop.kind === "failed") {
            observation.blockedBy = `[PERCH_ROUTE_BLOCKED] ${stop.reason}`;
            if (!targeting.blockedHeadRoute) blockHead(observation.blockedBy);
            else blockedBodyRoute = `${head.position}:${routeCloudRevision}:${bot.entity.position.floored()}`;
          }
          await this.end.tick(signal);
          continue;
        }
        const aim = nearestBodyPoint(bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0), target);
        if (!canMeleeTarget(bot, target)) {
          observation.blockedBy = `Clearing the observed block between the low stance and ${target.name}.`;
          report("clearing_part_sightline", { aim: point(aim) });
          const dug = await this.clearPerchSightline(aim, signal, () => this.end.danger || headMoved());
          if (dug.kind === "failed") {
            if (!targeting.blockedHeadRoute) { blockHead(dug.reason); continue; }
            return finish("stopped", dug.reason);
          }
          continue;
        }
        const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(bot, target), this.end.policy().combat));
        const heldBefore = bot.heldItem?.name;
        await equipCombatLoadout(bot, loadout);
        if (heldBefore !== bot.heldItem?.name) observation.resetReadiness(loadout.cooldownTicks);
        await bot.lookAt(aim, true);
        signal.throwIfAborted();
        observation.refresh();
        if (observation.ended || observation.died || this.end.danger || headMoved()) continue;
        if (bot.heldItem?.name.endsWith("_sword") && hasSweepBystander(bot, target)) {
          report("sweep_bystander");
          await this.end.tick(signal);
          continue;
        }
        if (observation.ready) {
          observation.stage = "attacking";
          observation.blockedBy = null;
          if (!this.end.policy().combat.melee) return finish("stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
          report("swinging");
          await this.end.phase("swing", async () => {
            bot.attack(target);
            observation.swung(loadout.cooldownTicks);
          });
        } else report("weapon_cooldown");
        await this.end.tick(signal);
      }
    } finally {
      report("request_releasing");
      bot.off("physicsTick", emitDiagnostic);
      await use.neutralise(async () => {
        if (!signal.aborted) await this.end.settle(signal);
      }, signal);
    }
  }

  /** A takeoff packet starts withdrawal; a supported, hazard-free interval ends it. */
  private async withdrawPerch(observation: PerchObservation, signal: AbortSignal): Promise<string | null> {
    observation.stage = "withdrawing";
    const deadline = Date.now() + this.end.policy().combat.evade_timeout_ms;
    let clearTicks = 0;
    let triedPreparedDescent = false;
    while (clearTicks < 10) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) return "[PERCH_RETREAT_INCOMPLETE] Takeoff did not reach stable clear footing within the escape budget.";
      if (this.end.danger) {
        clearTicks = 0;
        const notch = observation.preparationTarget;
        if (!triedPreparedDescent && notch && observation.preparedPosition) {
          triedPreparedDescent = true;
          const clouds = readDragonBreathHazards(this.end.bot);
          const destination = notch.offset(0.5, 0, 0.5);
          if (!this.cloudedPassage(notch, clouds) && observeDragonEscape(this.end.bot).clearAt(destination)) {
            const moved = await this.end.move(exactBlockGoal(notch), signal,
              () => this.cloudedPassage(notch) !== null,
              { ...this.perchMovements(clouds), allowDigging: false, allowPlacing: false, scaffold: null },
              Math.min(4000, deadline - Date.now()));
            if (moved.kind === "arrived" && !this.end.danger) continue;
          }
        }
        const escaped = await this.end.evade(signal);
        if (escaped.outcome !== "evaded") return `[PERCH_RETREAT_INCOMPLETE] ${escaped.reason}`;
      }
      await this.end.tick(signal);
      clearTicks = !this.end.danger && this.end.supported && !this.end.footing.needed ? clearTicks + 1 : 0;
    }
    observation.handoffComplete = true;
    return null;
  }
}
