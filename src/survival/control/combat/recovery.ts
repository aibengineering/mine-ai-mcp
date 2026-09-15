import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { combatDecisionEvidence, decideCombatResponse } from "../../policy/combat/decision.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import { contextPolicy } from "./context.js";
import { evade } from "../../responses/evade.js";
import { hideInPlace } from "../../responses/hide.js";
import type { Facts } from "../../state/answered.js";
import type { ResponseContext } from "./context.js";
import type { EngagementRecovery } from "./engagement.js";
import { observeCombatDecision } from "./observation.js";
import { deflectWithinCombat } from "./respond.js";
import { answeredResponses, responseScope } from "./scopes/response.js";

/** Keep ownership while executing the shared recovery decision and its physical fallback. */
export async function recoverCombatHealth(
  bot: Bot,
  navigation: NavigationRuntime,
  context: ResponseContext,
  signal: AbortSignal,
  recordDecision: (evidence: Facts) => void,
): Promise<EngagementRecovery> {
  const survival = context.survival;
  const policy = contextPolicy(context);
  // One recovery attempt can relocate once after a failed construction. It cannot
  // reopen its withdrawal budget by calling itself from a different route.
  const attempted = new Set<string>();
  const failures: string[] = [];
  const observed: ResponseContext = {
    ...context,
    survival,
    get blockedResponses() {
      return new Set([...answeredResponses(bot, policy, survival), ...attempted]);
    },
  };
  for (;;) {
    signal.throwIfAborted();
    if (bot.health <= 0) return { kind: "blocked", observation: "The bot died during recovery." };
    const facts = observeCombatDecision(bot, observed);
    const purpose = { kind: "recovery", targetId: null } as const;
    const response = decideCombatResponse(facts, purpose);
    recordDecision(combatDecisionEvidence(facts, purpose, response));
    if (response.kind === "deflect") {
      await deflectWithinCombat(bot, response.targetId, observed, signal);
      continue;
    }
    if (response.kind !== "hide" && response.kind !== "evade")
      return {
        kind: "blocked",
        observation: [
          ...failures,
          response.kind === "constrained" ? response.reason : "Immediate defence must settle before recovery.",
        ].join(" "),
      };
    const scope = responseScope(bot, policy, response.kind);
    if (response.kind === "hide") {
      const result = await hideInPlace(bot, {
        signal,
        threatContext: observed,
        recoverTo: recoveryHealth(policy().combat),
        maximumMs: policy().combat.recovery_timeout_ms,
      });
      signal.throwIfAborted();
      if (result.kind === "recovered") return { kind: "recovered" };
      const why = result.error ?? `Recovery stopped at health ${bot.health}, hunger ${bot.food}.`;
      failures.push(why);
      // A successful enclosure has its own exhausted recovery scope. It must not
      // become a failed construction, or a fresh place to spend ninety seconds.
      if (result.kind === "held") return { kind: "blocked", observation: failures.join(" ") };
      survival.answered.remember(scope, { kind: "enclosure_failed", why });
      if (attempted.has("evade")) return { kind: "blocked", observation: failures.join(" ") };
    } else {
      attempted.add("evade");
      const cell = bot.entity.position.floored();
      const result = await evade(bot, navigation, response, observed, bot.health, signal);
      signal.throwIfAborted();
      if (result.result.kind !== "separated" || cell.equals(bot.entity.position.floored())) {
        const why =
          "reason" in result.result ? result.result.reason : "Withdrawal did not establish a different recovery cell.";
        survival.answered.remember(scope, { kind: "escape_failed", why });
        return { kind: "blocked", observation: [...failures, why].join(" ") };
      }
    }
  }
}
