import type { CombatPerception } from "../../perception/combat/observations.js";
import type { HostileKnowledge } from "../../perception/combat/threats.js";
import { DEFAULT_COMBAT_POLICY, type CombatPolicy } from "../../policy/combat/contract.js";
import { DEFAULT_FOOD_POLICY, type FoodPolicy, type SurvivalPolicy } from "../../policy/contract.js";
import type { SurvivalResources } from "../../state/resources.js";

/** Decision inputs combine observed relationships with the admitted operation's state. */
export interface HostileContext extends HostileKnowledge {
  readonly survival?: SurvivalResources;
  /** Targets no route reached; retained by the operation across response changes. */
  readonly unreachableIds: ReadonlySet<number>;
  readonly policy?: Readonly<CombatPolicy>;
  readonly food?: Readonly<FoodPolicy>;
  readonly blockedResponses?: ReadonlySet<string>;
}

/** Physical responses borrow these from the runtime owner; they never create a second memory or sensor. */
export interface ResponseContext extends HostileContext {
  readonly survival: SurvivalResources;
  readonly policy: Readonly<CombatPolicy>;
  readonly food: Readonly<FoodPolicy>;
  readonly perception: Pick<CombatPerception, "read" | "creeperClearance" | "tick" | "resolvedIds">;
}

/** Combat scopes read combat and food; navigation reads its live policy at the runtime boundary. */
export function contextPolicy(
  context: Pick<HostileContext, "policy" | "food">,
): () => Readonly<Pick<SurvivalPolicy, "combat" | "food">> {
  return () => ({ combat: context.policy ?? DEFAULT_COMBAT_POLICY, food: context.food ?? DEFAULT_FOOD_POLICY });
}
