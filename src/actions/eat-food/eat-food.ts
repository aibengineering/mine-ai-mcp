import { eatCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { carriedCount } from "../../world/index.js";
import { eatFood } from "../../world/procedures/eating.js";
import { defineAction } from "../action.js";
import { unconfirmedCount } from "../markdown.js";
import {
  parseEatFoodRequest,
  EAT_FOOD,
  EAT_FOOD_DESCRIPTION,
  eatFoodInputSchema,
  eatFoodResultSchema,
  type EatFoodResult,
} from "./contract.js";

export function formatEatFoodResult(result: EatFoodResult): string {
  const { eating } = result;
  const lines = [
    eating.consumed ? `Consumed one **${eating.food}**.` : `No consumption of **${eating.food}** was observed.`,
    `- Inventory: ${eating.inventoryBefore} → ${eating.inventoryAfter}${unconfirmedCount(eating.confirmed)}`,
    `- Hunger: ${eating.hungerBefore} → ${eating.hungerAfter}`,
    `- Saturation: ${eating.saturationBefore.toFixed(2)} → ${eating.saturationAfter.toFixed(2)}`,
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createEatFoodAction(bot: Bot) {
  return defineAction({
    checkpointSchema: eatCheckpointSchema,
    name: EAT_FOOD,
    description: EAT_FOOD_DESCRIPTION,
    inputSchema: eatFoodInputSchema,
    resultSchema: eatFoodResultSchema,
    formatResult: formatEatFoodResult,
    execution: { kind: "task" },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    parse: parseEatFoodRequest,
    execute: (request, context) => {
      const before = { inventory: carriedCount(bot, request.foodName), hunger: bot.food, saturation: bot.foodSaturation };
      context.observeProgress?.(() => ({ baseline: { ...before },
        checkpoint: { phase: "eating", item: request.foodName, inventory: carriedCount(bot, request.foodName), hunger: bot.food, saturation: bot.foodSaturation },
        completion: { kind: "event", observed: false, owes: "Consumption and its inventory/hunger evidence must be confirmed by the eating executor." },
      }));
      return eatFood(bot, request, context);
    },
  });
}
