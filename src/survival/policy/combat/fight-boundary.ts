import type { CombatDecisionFacts, CombatPurpose } from "./decision.js";
import { decideCombatResponse } from "./decision.js";
import { needsCombatRecovery, recoveryHealth } from "./health.js";
import type { HostileDirective } from "./response.js";

/** Facts about the refuge already owned by this fight, not permission to build another. */
export interface FightProtection {
  readonly returnable: boolean;
  readonly atProtection: boolean;
  readonly foodLow: boolean;
  readonly foodAvailable: boolean;
}

export type FightBoundaryDecision =
  | { readonly kind: "fight" }
  | { readonly kind: "recover"; readonly health: number }
  | { readonly kind: "respond"; readonly response: HostileDirective };

/** A current refuge can execute recovery without giving up its position or body claim. */
export function decideFightBoundary(
  facts: CombatDecisionFacts,
  purpose: Extract<CombatPurpose, { kind: "pursuit" | "contact_defence" }>,
  protection: FightProtection,
): FightBoundaryDecision {
  const response = decideCombatResponse(facts, purpose);
  if (response.kind === "deflect") return { kind: "respond", response };
  const minimumHealth = purpose.kind === "pursuit" ? purpose.minimumHealth : 0;
  const hurt = needsCombatRecovery(facts.health, minimumHealth);
  const needsFood = protection.atProtection && protection.foodLow && protection.foodAvailable;
  if (
    protection.returnable &&
    (hurt || needsFood) &&
    facts.policy.recover !== "never" &&
    facts.recoveryAvailable &&
    !facts.answered.has("recovery")
  ) {
    return { kind: "recover", health: hurt ? Math.max(recoveryHealth(facts.policy), minimumHealth) : facts.health };
  }
  return response.kind === "fight" ? { kind: "fight" } : { kind: "respond", response };
}
