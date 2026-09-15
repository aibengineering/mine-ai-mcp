import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import {
  craftPlanEvidenceSchema,
  craftingRequestInputSchema,
  parseCraftingRequest,
  type CraftMaterial,
  type CraftingRequest,
} from "../crafting.js";
import { temporaryWorkstationInputSchema, workstationEvidenceSchema } from "../temporary-workstation.js";

export { craftMaterialSchema, craftPlanEvidenceSchema, craftStepSchema } from "../crafting.js";
export type { CraftMaterial, CraftPlanEvidence, CraftStep, RequestedCraftItem } from "../crafting.js";

export const CRAFT_ITEM = "craft_item" as const;
export const CRAFT_ITEM_DESCRIPTION =
  "Recursively craft every requested item from one shared inventory plan. When a recipe needs a crafting table and none is in reach, a carried one is placed on a cell chosen beside the bot. With temporary_workstation=true, requires a carried table and recovers it after the whole batch. Reports the selected recipe trees and missing leaf materials without gathering resources.";

export const craftItemInputSchema = craftingRequestInputSchema.extend({
  temporary_workstation: temporaryWorkstationInputSchema,
});
export interface CraftItemRequest extends CraftingRequest {
  readonly temporaryWorkstation?: boolean;
}

export const craftedItemEvidenceSchema = z.strictObject({
  item: z.string(),
  requested: z.number().int().positive(),
  gained: z.number().int().nonnegative(),
  /** Previously carried items spent on workstation setup, separate from the original baseline. */
  usedForWorkstation: z.number().int().nonnegative(),
  inventoryBefore: z.number().int().nonnegative(),
  inventoryAfter: z.number().int().nonnegative(),
  /** Whether `inventoryAfter` is the count the action expected; false when the server had not sent it in time. */
  confirmed: z.boolean(),
});

export const craftEvidenceSchema = z.strictObject({
  items: z.array(craftedItemEvidenceSchema).min(1),
  completedSteps: z.number().int().nonnegative(),
  plan: craftPlanEvidenceSchema.optional(),
  /** Where a carried crafting table was put down for this batch, when one had to be. */
  craftingTablePlaced: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).optional(),
});

export type CraftedItemEvidence = z.output<typeof craftedItemEvidenceSchema>;
export type CraftEvidence = z.output<typeof craftEvidenceSchema>;

export const craftItemResultSchema = actionResultSchema({
  craft: craftEvidenceSchema,
  workstation: workstationEvidenceSchema.optional(),
});
export type CraftItemResult = z.output<typeof craftItemResultSchema>;
export type CraftItemOutput = ActionOutput<typeof CRAFT_ITEM, CraftItemResult>;

export const craftItemAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

function itemList(items: readonly string[]): string {
  return items.join(", ");
}

export const craftItemOutcomes = {
  unknownItems: (items: readonly string[]) =>
    `[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: ${itemList(items)}.`,
  uncraftable: (items: readonly string[]) =>
    `[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: ${itemList(items)}.`,
  missingMaterials: (materials: readonly CraftMaterial[]) =>
    `[CRAFT_MATERIALS_MISSING] Missing leaf materials: ${materials.map(({ item, count }) => `${item} x${count}`).join(", ")}.`,
  plannerFailed: (items: readonly string[]) =>
    `[CRAFT_PLAN_UNAVAILABLE] The recursive planner found recipes but could not produce concrete plans for: ${itemList(items)}.`,
  craftingTableRequired:
    "[CRAFTING_TABLE_REQUIRED] This recipe batch needs a crafting table within the bot's four-block interaction reach; none is in reach and no carried one could be placed beside the bot.",
  executionFailed: (cause: unknown) =>
    `[CRAFT_EXECUTION_FAILED] Mineflayer stopped while executing the selected recipe batch: ${cause instanceof Error ? cause.message : String(cause)}`,
  resultNotObserved: (items: readonly CraftedItemEvidence[]) =>
    `[CRAFT_RESULTS_NOT_OBSERVED] The selected recipe batch finished without the requested gains: ${items.map(({ item, gained, requested }) => `${item} ${gained}/${requested}`).join(", ")}.`,
} as const;

export function parseCraftItemRequest(input: unknown): CraftItemRequest {
  const { temporary_workstation, ...crafting } = craftItemInputSchema.parse(input ?? {});
  return {
    ...parseCraftingRequest(crafting),
    ...(temporary_workstation !== undefined && { temporaryWorkstation: temporary_workstation }),
  };
}
