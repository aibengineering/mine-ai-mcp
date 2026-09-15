import { z } from "zod";
import { actionResultSchema } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const BARTER = "barter" as const;
export const BARTER_DESCRIPTION =
  "Collect a requested item through loaded ground drops and gold offers to one explicitly selected adult piglin. Bartering for ender pearls is usually much slower than searching for and hunting endermen; prefer endermen for collecting pearls in the Nether in most cases. Collects existing desired drops first, including with gold_budget 0. Each native offer spends at most one gold ingot; unconfirmed offers reserve budget too. Success means additional desired items are carried, never merely that gold was lost. Random rewards are not guaranteed. Cancellation and reflex resumption retain the original target quantity and spending budget.";

export const barterInputSchema = z.strictObject({
  piglin_id: z
    .number()
    .int()
    .nonnegative()
    .describe("Exact loaded adult piglin ID from view_status; never substitutes another piglin."),
  item_name: registryNameSchema.describe("Desired item. Existing loaded drops are collected before offering gold."),
  count: z.number().int().positive().default(1).describe("Additional desired items to carry during this request."),
  gold_budget: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Maximum one-ingot offers, including an interrupted or unconfirmed offer. Zero only collects existing desired drops.",
    ),
});
export type BarterRequest = z.output<typeof barterInputSchema>;
export const barterResultSchema = actionResultSchema({
  barter: z.strictObject({
    piglinId: z.number().int(),
    item: z.string(),
    requested: z.number().int(),
    inventoryBefore: z.number().int(),
    inventoryAfter: z.number().int(),
    gained: z.number().int(),
    goldBudget: z.number().int(),
    goldOffers: z.number().int(),
    goldSpent: z.number().int(),
  }),
});
export type BarterResult = z.output<typeof barterResultSchema>;
