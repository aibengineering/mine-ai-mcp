import type { Bot } from "mineflayer";
import { createMovements, safeFromEntitiesGoal, type NavigationRuntime } from "../../navigation/index.js";
import { isHeadPassable, isPassable, isSafeSupport, navigationFeet } from "../../navigation/world/block-geometry.js";
import type { ResponseContext } from "../control/combat/context.js";
import { encounterBaseline, type EvadeResponseResult } from "../control/combat/response-result.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { observeExposedAvoidanceContact } from "../perception/combat/threats.js";
import { permittedCombatItems } from "../policy/combat/permissions.js";
import { creeperEscape } from "../policy/combat/tactics.js";
import type { HostileDirective } from "../policy/combat/response.js";
import { equipCombatLoadout, readCombatItems, selectMeleeLoadout } from "../weapons/equipment.js";
import { combatItemsForTarget } from "../weapons/melee.js";
import {
  guardRetreatProjectiles,
  RETREAT_PROJECTILE_ALLOWANCE,
  retreatGuardLimit,
} from "../weapons/projectile-guard.js";
import { defendWhileRetreating } from "../weapons/retreat-melee.js";
const EVADE_ARRIVAL_MARGIN = 8;
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
    if (escape) perception.creeperClearance.require(creepers.filter(threat => escape.threatIds.includes(threat.id)));
    return escape !== null;
  };
  let guardStop: string | null = null;
  // Select the hand before navigation starts owning digs and placements.
  const target = request.threats.map((threat) => bot.entities[threat.id]).find((entity) => entity?.isValid);
  const carried = target ? combatItemsForTarget(bot, target) : readCombatItems(bot);
  await equipCombatLoadout(bot, selectMeleeLoadout(permittedCombatItems(carried, context.policy)));
  signal.throwIfAborted();
  using defence = defendWhileRetreating(bot, context, signal);
  const makeGoal = () => safeFromEntitiesGoal([...threats.values()], request.safeRange + EVADE_ARRIVAL_MARGIN);
  let goal = makeGoal();
  const observe = () => {
    if (signal.aborted) return;
    // Keep the same last observation for the navigation goal and final evidence.
    // A creeper explosion removes the entity without necessarily emitting entityDead.
    for (const [id, threat] of threats) {
      const entity = bot.entities[id];
      if (entity?.isValid)
        threats.set(id, {
          ...threat,
          position: { ...entity.position },
          distance: entity.position.distanceTo(bot.entity.position),
        });
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
    };
  };
  try {
    observe();
    // Damage can arrive while a viable escape is accelerating. Stopping here
    // left the bot trying to build cover with melee attackers already on it.
    // Let this admitted route reach separation or its existing physical limit.
    let route: Awaited<ReturnType<NavigationRuntime["navigate"]>>;
    for (;;) {
      const routeStart = bot.entity.position.floored();
      const incoming = new AbortController();
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
                  scaffolding: context.policy?.terrain.place,
                }),
                goal: { resolve: (observation) => goal.resolve(observation) },
                signal,
                stopSignal: incoming.signal,
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
