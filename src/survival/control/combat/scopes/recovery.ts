import type { Bot } from "mineflayer";
import { REGENERATION_HUNGER } from "../../../../world/food.js";
import { hasRegeneration } from "../../../perception/combat/recovery.js";
import { recoveryHealth } from "../../../policy/combat/health.js";
import type { SurvivalPolicy } from "../../../policy/contract.js";
import { rawFoodPermitted } from "../../../policy/food.js";
import type { AnsweredScope } from "../../../state/answered.js";

/** Enclosure and damage are not recovery premises. One exhausted hold survives both. */
export function recoveryScope(
  bot: Bot,
  policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>,
  recoverTo: number,
): AnsweredScope {
  return {
    capability: "recovery",
    response: "recover",
    scope: `dimension:${bot.game.dimension}`,
    facts: () => {
      return {
        foods: bot.inventory
          .items()
          .filter((item) => bot.registry.foodsByName[item.name])
          .map((item) => ({ name: item.name, count: item.count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        hungerEligible: bot.food >= REGENERATION_HUNGER,
        regeneration: hasRegeneration(bot),
        recovered: bot.health >= recoverTo,
        // A hold answered while raw meat was withheld reopens once a floor releases it.
        rawFoodPermitted: rawFoodPermitted(policy().food.raw, { health: bot.health, hunger: bot.food }).permitted,
      };
    },
    permissions: () => ({
      recover: policy().combat.recover,
      rawFood: { ...policy().food.raw },
      requiredHealth: recoveryHealth(policy().combat),
      maximumMs: policy().combat.recovery_timeout_ms,
    }),
  };
}
