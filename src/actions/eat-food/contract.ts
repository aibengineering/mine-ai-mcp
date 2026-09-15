import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const EAT_FOOD = "eat_food" as const;
export const EAT_FOOD_DESCRIPTION =
  "Eat one exact carried food item through Mineflayer and report the observed inventory and hunger change.";

export const eatFoodInputSchema = z.strictObject({
  food_name: registryNameSchema.describe("Exact carried food registry name, such as cooked_beef or apple."),
});

export interface EatFoodRequest {
  readonly foodName: string;
}

export function parseEatFoodRequest(input: unknown): EatFoodRequest {
  const value = eatFoodInputSchema.parse(input ?? {});
  return { foodName: value.food_name };
}

export const eatFoodEvidenceSchema = z.strictObject({
  food: z.string(),
  inventoryBefore: z.number().int().nonnegative(),
  inventoryAfter: z.number().int().nonnegative(),
  /** Whether `inventoryAfter` is the count the action expected; false when the server had not sent it in time. */
  confirmed: z.boolean(),
  hungerBefore: z.number().nonnegative(),
  hungerAfter: z.number().nonnegative(),
  saturationBefore: z.number().nonnegative(),
  saturationAfter: z.number().nonnegative(),
  consumed: z.boolean(),
});

export const eatFoodResultSchema = actionResultSchema({
  eating: eatFoodEvidenceSchema,
});

export type EatFoodEvidence = z.output<typeof eatFoodEvidenceSchema>;
export type EatFoodResult = z.output<typeof eatFoodResultSchema>;
export type EatFoodOutput = ActionOutput<typeof EAT_FOOD, EatFoodResult>;

export const eatFoodAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const eatFoodOutcomes = {
  unknownFood: (foodName: string) => `[EAT_UNKNOWN_FOOD] Minecraft does not classify ${foodName} as food.`,
  notCarried: (foodName: string) => `[EAT_FOOD_MISSING] Bot inventory contains no ${foodName}.`,
  notObserved: (foodName: string) =>
    `[EAT_NOT_OBSERVED] No inventory decrease for ${foodName} was observed after the consume call.`,
  rejected: (cause: unknown) =>
    `[EAT_REJECTED] Mineflayer could not consume the selected food: ${cause instanceof Error ? cause.message : String(cause)}`,
} as const;
