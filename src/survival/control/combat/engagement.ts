import type { CombatDecisionFacts, CombatPurpose } from "../../policy/combat/decision.js";
import { decideCombatResponse } from "../../policy/combat/decision.js";
import type { HostileDirective } from "../../policy/combat/response.js";
import type { CombatOutcome, CombatResult } from "./contract.js";

export type FightOutcome = CombatOutcome | (CombatResult<"response_required"> & { readonly observation: string });
export type EngagementRecovery =
  { readonly kind: "recovered" } | { readonly kind: "blocked"; readonly observation: string };

export interface EngagementOperations {
  readonly purpose: Extract<CombatPurpose, { kind: "pursuit" | "contact_defence" }>;
  observe(): CombatDecisionFacts;
  record(facts: CombatDecisionFacts, response: HostileDirective): void;
  fight(): Promise<FightOutcome>;
  recover(): Promise<EngagementRecovery>;
  deflect(targetId: number): Promise<void>;
}

/** One requested quarry survives every selected response; completed effects accumulate once. */
export async function runEngagement(signal: AbortSignal, operations: EngagementOperations): Promise<CombatOutcome> {
  const evidence = {
    targetId: operations.purpose.targetId,
    attacks: 0,
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    stylesUsed: [] as CombatOutcome["stylesUsed"][number][],
    weaponsUsed: [] as string[],
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const facts = operations.observe();
      if (facts.health <= 0) return { ...evidence, kind: "bot_died" };
      const response = decideCombatResponse(facts, operations.purpose);
      operations.record(facts, response);
      switch (response.kind) {
        case "deflect":
          await operations.deflect(response.targetId);
          break;
        case "hide":
        case "evade": {
          const recovery = await operations.recover();
          signal.throwIfAborted();
          if (operations.observe().health <= 0) return { ...evidence, kind: "bot_died" };
          if (recovery.kind === "blocked")
            return { ...evidence, kind: "capability_blocked", reason: "recovery", observation: recovery.observation };
          break;
        }
        case "fight": {
          const result = await operations.fight();
          evidence.attacks += result.attacks;
          evidence.shieldRaisedSwings += result.shieldRaisedSwings;
          evidence.projectileGuards += result.projectileGuards;
          evidence.explosions += result.explosions;
          evidence.stylesUsed = [...new Set([...evidence.stylesUsed, ...result.stylesUsed])];
          evidence.weaponsUsed = [...new Set([...evidence.weaponsUsed, ...result.weaponsUsed])];
          if (result.kind !== "response_required") return { ...result, ...evidence };
          break;
        }
        case "constrained":
          return {
            ...evidence,
            kind: "capability_blocked",
            reason:
              operations.purpose.kind === "pursuit" && facts.health < operations.purpose.minimumHealth
                ? "recovery"
                : "policy",
            observation: response.reason,
          };
        case "none":
          return { ...evidence, kind: "target_lost" };
      }
    }
  } catch (cause) {
    if (signal.aborted && cause === signal.reason) return { ...evidence, kind: "cancelled" };
    throw cause;
  }
}
