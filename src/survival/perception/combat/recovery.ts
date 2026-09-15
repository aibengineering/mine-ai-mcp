import type { Bot } from "mineflayer";
import { REGENERATION_HUNGER } from "../../../world/food.js";
import type { FoodPolicy } from "../../policy/contract.js";
import { selectPolicyFood } from "../food.js";

/** The client observes food, hunger and effects; vanilla does not send naturalRegeneration. */
export function recoveryAvailable(bot: Bot, food: Readonly<FoodPolicy>): boolean {
  return bot.food >= REGENERATION_HUNGER || hasRegeneration(bot) || selectPolicyFood(bot, food).food !== null;
}

export function hasRegeneration(bot: Bot): boolean {
  const effect = bot.registry.effectsByName?.Regeneration?.id;
  return effect !== undefined && bot.entity.effects?.[effect] !== undefined;
}
