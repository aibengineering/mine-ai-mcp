import { encounterBaseline, type EvadeResponseResult } from "./encounter.js";
import type { Bot } from "mineflayer";
import { createMovements, safeFromEntitiesGoal, type NavigationRuntime } from "../../navigation/index.js";
import { isHeadPassable, isPassable, isSafeSupport, navigationFeet } from "../../navigation/world/block-geometry.js";
import type { ResponseContext } from "../perception/combat/context.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { observeExposedAvoidanceContact } from "../perception/combat/threats.js";
import { permittedCombatItems } from "../policy/combat/permissions.js";
import { creeperEscape, creeperEscapeAdmits } from "../policy/combat/tactics.js";
import type { HostileDirective } from "../policy/combat/response.js";
import { combatItemsForTarget } from "../weapons/melee.js";
import {
  guardRetreatProjectiles,
  RETREAT_PROJECTILE_ALLOWANCE,
  retreatGuardLimit,
} from "../weapons/projectile-guard.js";
import { defendWhileRetreating } from "../weapons/retreat-melee.js";
import { equipCombatLoadout, readCombatItems, selectMeleeLoadout } from "../weapons/equipment.js";
const EVADE_ARRIVAL_MARGIN = 8;
// A hostile this close in front of a moving body is about to be run into.
const CLOSING_AHEAD_RANGE = 3;
const CLOSING_AHEAD_COSINE = Math.cos((60 * Math.PI) / 180);
// Below this the body has stopped; a hostile beside it is not on its heading.
const CLOSING_AHEAD_SPEED = 0.1;
// How far back a hostile's own motion is read, and the speed toward the body
// (blocks per tick) above which it is coming at the body rather than lying in
// the route.
const APPROACH_TICKS = 3;
const APPROACH_SPEED = 0.05;

/**
 * The hostile the moving body is about to run into, if any. An evade route is
 * priced against hostiles where the search saw them and then walked for up to
 * fifty steps, but the escape itself moves them: a sprinting retreat strike
 * knocks its target several blocks along the body's heading. CubeEvade
 * punched the small magma cube from beside its route onto it, caught it up
 * and punched it on four more times, then ran into it and was struck at 1.8
 * blocks (cube-ab-base t00012, as in r3-cube t00001 and t00014). Searching
 * again from where the cube now lies takes the other side of the shelf.
 *
 * Only a hostile lying in the route or carried along it counts, not one coming
 * at the body: the stop and the search that follow stood WitherEvade still
 * beside a closing wither skeleton for a second, and it was struck until it
 * died (cube-proof3 t00004).
 */
export function threatClosingAhead(
  position: { readonly x: number; readonly z: number },
  velocity: { readonly x: number; readonly z: number },
  threats: readonly {
    readonly id: number;
    readonly position: { readonly x: number; readonly z: number };
    /** Where it was `APPROACH_TICKS` ticks ago; null until it has been watched that long. */
    readonly earlier: { readonly x: number; readonly z: number } | null;
  }[],
): number | null {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < CLOSING_AHEAD_SPEED) return null;
  let nearest: { id: number; distance: number } | null = null;
  for (const threat of threats) {
    if (threat.earlier === null) continue;
    const dx = threat.position.x - position.x, dz = threat.position.z - position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > CLOSING_AHEAD_RANGE || distance === 0) continue;
    const towardBody =
      ((threat.earlier.x - threat.position.x) * dx + (threat.earlier.z - threat.position.z) * dz) /
      (distance * APPROACH_TICKS);
    if (towardBody > APPROACH_SPEED) continue;
    if ((dx * velocity.x + dz * velocity.z) / (distance * speed) < CLOSING_AHEAD_COSINE) continue;
    if (!nearest || distance < nearest.distance) nearest = { id: threat.id, distance };
  }
  return nearest?.id ?? null;
}
export async function evade(
  bot: Bot,
  navigation: NavigationRuntime,
  request: Extract<HostileDirective, { kind: "evade" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<EvadeResponseResult> {
  const threats = new Map(request.threats.map((threat) => [threat.id, threat]));
  const dead = new Set<number>();
  using budget = context.survival.budgets.attempt({
    name: "evade",
    scope: `cell:${bot.entity.position.floored()}`,
    unit: "milliseconds",
    limit: context.policy.evade_timeout_ms,
    measure: Date.now,
    exhaustion:
      "Return observed separation or an exhausted escape; route changes and projectile guards cannot renew it.",
  });
  let projectileGuards = 0;
  let explosions = 0;
  const explosion = () => { explosions++; };
  const escapeRequired = () => {
    const { perception } = context;
    const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
    const escape = creeperEscape({ creepers, clearancePending: perception.creeperClearance.pending, stationaryCommitment: true });
    if (escape) perception.creeperClearance.require(creepers.filter(threat => creeperEscapeAdmits(escape).includes(threat.id)));
    return escape !== null;
  };
  let guardStop: string | null = null;
  // Hostiles a route was stopped for and searched again around, in order.
  const replannedFor: number[] = [];
  // Select the hand before navigation starts owning digs and placements.
  const target = request.threats.map((threat) => bot.entities[threat.id]).find((entity) => entity?.isValid);
  const carried = target ? combatItemsForTarget(bot, target) : readCombatItems(bot);
  await equipCombatLoadout(bot, selectMeleeLoadout(permittedCombatItems(carried, context.policy)));
  signal.throwIfAborted();
  using defence = defendWhileRetreating(bot, context, signal);
  const makeGoal = () => safeFromEntitiesGoal([...threats.values()], request.safeRange + EVADE_ARRIVAL_MARGIN);
  let goal = makeGoal();
  // Each threat's last few observed positions, oldest first.
  const trails = new Map<number, { readonly x: number; readonly z: number }[]>();
  const observe = () => {
    if (signal.aborted) return;
    // Keep the same last observation for the navigation goal and final evidence.
    // A creeper explosion removes the entity without necessarily emitting entityDead.
    for (const [id, threat] of threats) {
      const entity = bot.entities[id];
      if (!entity?.isValid) continue;
      threats.set(id, {
        ...threat,
        position: { ...entity.position },
        distance: entity.position.distanceTo(bot.entity.position),
      });
      const trail = trails.get(id) ?? [];
      trail.push({ x: entity.position.x, z: entity.position.z });
      if (trail.length > APPROACH_TICKS + 1) trail.shift();
      trails.set(id, trail);
    }
    for (const threat of observeExposedAvoidanceContact(bot, context)) {
      if (dead.has(threat.id) || threats.has(threat.id)) continue;
      threats.set(threat.id, threat);
    }
    goal = makeGoal();
  };
  // A retreat changes the neighbourhood. Retain the threats of this response
  // and include new contacts as they enter the same policy's observed range.
  const resolved = (entity: Bot["entity"]) => {
    dead.add(entity.id);
    trails.delete(entity.id);
    if (threats.delete(entity.id)) goal = makeGoal();
  };
  bot.on("entityDead", resolved);
  bot.on("physicsTick", observe);
  bot._client.on("explosion", explosion);
  const observeEvidence = () => {
    const melee = defence.evidence();
    return {
      ...encounterBaseline(bot, { ...request, threats: [...threats.values()] }, healthBefore),
      response: "evade" as const,
      ...melee,
      combatStyles: melee.attacks > 0 ? ["melee" as const] : [],
      shieldRaisedSwings: 0,
      projectileGuards,
      explosions,
      replannedFor: [...replannedFor],
    };
  };
  try {
    observe();
    // Damage can arrive while a viable escape is accelerating. Stopping here
    // left the bot trying to build cover with melee attackers already on it.
    // Let this admitted route reach separation or its existing physical limit.
    let route: Awaited<ReturnType<NavigationRuntime["navigate"]>>;
    // One replan per hostile per approach: a route that must still pass it
    // is not stopped again until it has been left behind.
    const rerouted = new Set<number>();
    for (;;) {
      const routeStart = bot.entity.position.floored();
      const incoming = new AbortController();
      const closing = new AbortController();
      const observeClosing = () => {
        const live = [...threats.values()].filter((threat) => bot.entities[threat.id]?.isValid);
        for (const id of rerouted)
          if (!live.some((threat) => threat.id === id && threat.distance <= CLOSING_AHEAD_RANGE + 2)) rerouted.delete(id);
        const ahead = threatClosingAhead(
          bot.entity.position,
          bot.entity.velocity,
          live
            .filter((threat) => !rerouted.has(threat.id))
            .map((threat) => {
              const trail = trails.get(threat.id) ?? [];
              const earlier = trail.length > APPROACH_TICKS ? trail[0]! : null;
              return { id: threat.id, position: threat.position, earlier };
            }),
        );
        if (ahead === null || closing.signal.aborted) return;
        rerouted.add(ahead);
        replannedFor.push(ahead);
        closing.abort(`Hostile #${ahead} closed on the route ahead.`);
      };
      const observeProjectile = () => {
        if (
          (context.policy?.shield ?? true) &&
          !escapeRequired() &&
          !retreatGuardLimit(bot, context.policy) &&
          incomingShieldProjectiles(bot, RETREAT_PROJECTILE_ALLOWANCE).length > 0
        )
          incoming.abort("Incoming projectile requires a settled shield guard.");
      };
      bot.on("physicsTick", observeProjectile);
      bot.on("physicsTick", observeClosing);
      try {
        observeProjectile();
        // An already-settled body has no route to cancel. Start readiness now
        // instead of paying a navigation admission/cleanup tick before guard.
        route =
          incoming.signal.aborted && bot.entity.onGround
            ? { status: "stopped", reason: String(incoming.signal.reason), elapsedMs: 0 }
            : await navigation.navigate({
                // Incoming damage can reset velocity before the next shield guard.
                // A four-block gap then has no recoverable landing (native fortress
                // replay). Retreat may sprint, step and build supported routes, but
                // must not depend on uninterrupted momentum over an empty gap.
                movements: createMovements(bot, {
                  allowParkour: false,
                  allowDigging: context.policy?.terrain.dig,
                  // A break the carried tools cannot harvest is the slow one:
                  // stone by hand takes 7.5 s. The Cave pen of
                  // creeper-navigation, cornered at a tunnel's end with only a
                  // sword, routed through the wall and was blown up while
                  // swinging at it (combat-proof6 2026-10-20T23-08-08-401Z).
                  requireHarvestTool: true,
                  scaffolding: context.policy?.terrain.place,
                }),
                goal: { resolve: (observation) => goal.resolve(observation) },
                signal,
                stopSignal: AbortSignal.any([incoming.signal, closing.signal]),
                timeoutMs: Math.max(1, budget.remaining),
                // Separation chooses the destination; the registered hostile field also
                // prices the path there. Without it an evade ran through a magma cube
                // and kept retrying the same jump into it until the bot died.
                // This is the user-requested emergency horizon: commit a useful partial
                // route after at most 500 ms of search rather than standing still to polish it.
                // The search radius must contain the 44-block safety goal. Four additional
                // blocks leave room for an integral arrival cell without changing the
                // requested 500 ms emergency planning horizon.
                searchLimits: { primaryTimeoutMs: 500, failureTimeoutMs: 500, maximumRadius: 48 },
              });
      } finally {
        bot.off("physicsTick", observeProjectile);
        bot.off("physicsTick", observeClosing);
      }
      observe();
      const stillContact = encounterBaseline(
        bot,
        { ...request, threats: [...threats.values()] },
        healthBefore,
      ).finalDistances.some((entry) => entry.distance < request.safeRange);
      // A cube can split as a route completes. The old goal was reached, but
      // its newly observed children still need separation. Continue only after
      // a route that changed cells, within the same escape deadline.
      if (
        !signal.aborted &&
        route.status === "completed" &&
        stillContact &&
        !bot.entity.position.floored().equals(routeStart) &&
        !budget.exhausted
      )
        continue;
      // Search again from here, pricing the hostile where it now is.
      if (!signal.aborted && !incoming.signal.aborted && closing.signal.aborted && !budget.exhausted) continue;
      if (signal.aborted || !incoming.signal.aborted || budget.exhausted) break;
      // Navigation has settled its current landing/dig before releasing the
      // body. Turning inside its tick listener would steer the escape back
      // toward the shooter; the guard owns looking only between routes.
      projectileGuards++;
      const guard = await guardRetreatProjectiles(
        bot,
        navigation,
        signal,
        Date.now() + budget.remaining,
        context.policy,
        escapeRequired,
      );
      if (guard.kind === "stopped") {
        guardStop = guard.reason;
        break;
      }
      if (budget.exhausted) break;
    }
    observe();
    const common = observeEvidence();
    const separated = common.finalDistances.every((entry) => entry.distance >= request.safeRange);
    if (separated) {
      // The route aims beyond the required range to allow for pursuit. A
      // timeout at 43 blocks had already escaped the required 36, but was
      // reported as failure and armed an unnecessary emergency hide.
      const at = navigationFeet(bot.entity.position, bot.entity.onGround);
      if (
        route.status === "completed" ||
        (bot.entity.onGround &&
          isSafeSupport(navigation.world.blockAt(at.x, at.y - 1, at.z)) &&
          isPassable(navigation.world.blockAt(at.x, at.y, at.z)) &&
          isHeadPassable(navigation.world.blockAt(at.x, at.y + 1, at.z)))
      )
        return { ...common, result: { kind: "separated" } };
    }
    return {
      ...common,
      result: {
        kind: "exhausted",
        reason:
          guardStop ??
          (route.status === "stopped"
            ? `Emergency evade stopped without settled safe separation: ${route.reason}.`
            : "Emergency evade completed without observing the requested separation."),
      },
    };
  } catch (cause) {
    // Navigation cancellation can throw after real strikes and kills. Keep
    // this response's evidence; the hostile driver adapter owns cancellation status.
    return {
      ...observeEvidence(),
      result: { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) },
    };
  } finally {
    bot.off("physicsTick", observe);
    bot.off("entityDead", resolved);
    bot._client.off("explosion", explosion);
  }
}
