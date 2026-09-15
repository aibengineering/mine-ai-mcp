import { REGENERATION_HUNGER } from "../../world/food.js";
import type { FoodPolicy } from "./contract.js";

export type RawFoodRule = FoodPolicy["raw"];

export interface RawFoodVerdict {
  readonly permitted: boolean;
  /** Why raw food is, or is not, on the menu right now; written for the model. */
  readonly reason: string;
}

/**
 * Whether the automatic eaters may spend uncooked food now.
 *
 * Raw meat is worth more than twice as much cooked, and a hunt that eats its
 * own drops raw never has anything left to cook. So raw food is held back
 * until going without it costs something real: sprinting stops at six hunger,
 * and a wounded bot below the health floor cannot regenerate without eating.
 * The floors are policy so the model can move them for a long trip or a
 * fight it wants to finish on whatever it carries.
 */
export function rawFoodPermitted(
  rule: RawFoodRule,
  vitals: { readonly health: number; readonly hunger: number },
): RawFoodVerdict {
  if (rule.allow === "never") return { permitted: false, reason: "the raw_food policy never eats uncooked food" };
  if (rule.allow === "always") return { permitted: true, reason: "the raw_food policy allows uncooked food at any time" };
  if (vitals.hunger <= rule.hunger_at_most) {
    return {
      permitted: true,
      reason: `hunger ${vitals.hunger} is at or below the raw_food floor of ${rule.hunger_at_most}`,
    };
  }
  if (vitals.health < rule.health_below && vitals.hunger < REGENERATION_HUNGER) {
    return {
      permitted: true,
      reason: `health ${vitals.health} is below the raw_food floor of ${rule.health_below} and hunger ${vitals.hunger} cannot regenerate it`,
    };
  }
  return {
    permitted: false,
    reason:
      `uncooked food is kept for cooking until hunger is at most ${rule.hunger_at_most} ` +
      `or health is below ${rule.health_below} with hunger under ${REGENERATION_HUNGER} (raw_food policy)`,
  };
}
