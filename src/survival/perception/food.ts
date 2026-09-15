import type { Bot } from "mineflayer";
import { isRawFood, selectReflexFood, type ReflexFood } from "../../world/food.js";
import type { FoodPolicy } from "../policy/contract.js";
import { rawFoodPermitted, type RawFoodVerdict } from "../policy/food.js";

export interface PolicyFoodSelection {
  /** The meal the automatic eaters may take now, or null. */
  readonly food: ReflexFood | null;
  /** The uncooked food that would have been eaten had the raw_food policy allowed it. */
  readonly withheld: ReflexFood | null;
  readonly verdict: RawFoodVerdict;
}

/**
 * The reflex meal under the raw_food rule, naming what the rule held back.
 *
 * Every automatic eater (the hunger reflex, covered recovery, the End perch)
 * selects through here so one policy edit changes all of them at once.
 * Explicit eat_food requests do not: the model chose that meal itself.
 */
export function selectPolicyFood(bot: Bot, food: Readonly<FoodPolicy>): PolicyFoodSelection {
  const verdict = rawFoodPermitted(food.raw, { health: bot.health, hunger: bot.food });
  const best = selectReflexFood(bot, { allowRaw: true });
  if (best === null || verdict.permitted || !isRawFood(best.name)) return { food: best, withheld: null, verdict };
  // The most filling meal is uncooked and held back; a lesser cooked meal still counts.
  const cooked = selectReflexFood(bot, { allowRaw: false });
  return { food: cooked, withheld: cooked === null ? best : null, verdict };
}
