import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { isSafeSupport, navigationFeet } from "../../../navigation/world/block-geometry.js";
import type { Position3 } from "../../../utils/index.js";
import { dragonDanger } from "../../../world/dragon-hazards.js";
import { isBurning, isInLava } from "../../perception/body.js";
import { incomingFireball } from "../../perception/combat/fireball.js";
import { incomingShieldProjectiles } from "../../perception/combat/shield-projectiles.js";
import { HOSTILE_OBSERVATION_RANGE, observeExposedAvoidanceContact } from "../../perception/combat/threats.js";
import { combatDecisionEvidence, decideCombatResponse } from "../../policy/combat/decision.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import { contextPolicy } from "./context.js";
import { evade } from "../../responses/evade.js";
import { hideInPlace } from "../../responses/hide.js";
import type { Facts } from "../../state/answered.js";
import type { ResponseContext } from "./context.js";
import { observeCombatDecision } from "./observation.js";
import { deflectWithinCombat } from "./respond.js";
import { answeredResponses, responseScope } from "./scopes/response.js";

export type CombatHandoff =
  | {
      readonly kind: "safe";
      readonly basis: "clear" | "separated" | "sheltered";
      readonly position: Position3;
      readonly observedAt: number;
    }
  | { readonly kind: "unsafe"; readonly reason: string; readonly position: Position3; readonly observedAt: number };

/** Response choice is shared; this owner proves the current physical handoff. */
export async function secureCombatHandoff(
  bot: Bot,
  navigation: NavigationRuntime,
  context: ResponseContext,
  signal: AbortSignal,
  recordDecision: (evidence: Facts) => void,
): Promise<CombatHandoff> {
  const observation = () => ({
    observedAt: Date.now(),
    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
  });
  const survival = context.survival;
  const policy = contextPolicy(context);
  const spent = new Set<string>();
  const observed: ResponseContext = {
    ...context,
    survival,
    get blockedResponses() {
      return new Set([...answeredResponses(bot, policy, survival), ...spent]);
    },
  };
  const physicalSafety = () => {
    const feet = navigationFeet(bot.entity.position, bot.entity.onGround);
    return (
      bot.health > 0 &&
      bot.entity.onGround &&
      !isBurning(bot) &&
      !isInLava(bot) &&
      !incomingFireball(bot, HOSTILE_OBSERVATION_RANGE) &&
      !dragonDanger(bot) &&
      // The body is stationary here. Expanding it to a retreat corridor can
      // intersect a projectile outside the walls of a completed shelter.
      incomingShieldProjectiles(bot).length === 0 &&
      isSafeSupport(navigation.world.blockAt(feet.x, feet.y - 1, feet.z))
    );
  };
  const failures: string[] = [];
  for (;;) {
    signal.throwIfAborted();
    if (physicalSafety() && observeExposedAvoidanceContact(bot, context).length === 0)
      return { kind: "safe", basis: "clear", ...observation() };
    if (bot.health <= 0) return { kind: "unsafe", reason: "The bot died before handoff.", ...observation() };
    const facts = observeCombatDecision(bot, observed);
    const purpose = { kind: "handoff" } as const;
    const response = decideCombatResponse(facts, purpose);
    recordDecision(combatDecisionEvidence(facts, purpose, response));
    if (response.kind === "deflect") {
      await deflectWithinCombat(bot, response.targetId, observed, signal);
      continue;
    }
    if (response.kind !== "hide" && response.kind !== "evade")
      return {
        kind: "unsafe",
        reason: [
          ...failures,
          response.kind === "constrained"
            ? response.reason
            : "Immediate explosive projectile or dragon defence is still required.",
        ].join(" "),
        ...observation(),
      };
    spent.add(response.kind);
    const scope = responseScope(bot, policy, response.kind);
    if (response.kind === "hide") {
      const result = await hideInPlace(bot, {
        signal,
        threatContext: observed,
        recoverTo: recoveryHealth(policy().combat),
        maximumMs: policy().combat.recovery_timeout_ms,
      });
      signal.throwIfAborted();
      if (result.kind !== "failed" && physicalSafety()) return { kind: "safe", basis: "sheltered", ...observation() };
      const why = `Shelter: ${result.error ?? result.kind}.`;
      failures.push(why);
      if (result.kind === "failed") survival.answered.remember(scope, { kind: "enclosure_failed", why });
    } else {
      const result = await evade(bot, navigation, response, observed, bot.health, signal);
      signal.throwIfAborted();
      if (result.result.kind === "separated" && physicalSafety())
        return { kind: "safe", basis: "separated", ...observation() };
      const why = `Withdrawal: ${"reason" in result.result ? result.result.reason : result.result.kind}.`;
      failures.push(why);
      if (result.result.kind !== "separated") survival.answered.remember(scope, { kind: "escape_failed", why });
    }
  }
}
