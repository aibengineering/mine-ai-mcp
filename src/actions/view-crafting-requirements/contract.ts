import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import {
  craftPlanEvidenceSchema,
  craftingRequestInputSchema,
  parseCraftingRequest,
  type CraftingRequest,
} from "../crafting.js";

export const VIEW_CRAFTING_REQUIREMENTS = "view_crafting_requirements" as const;
export const VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION =
  "Inspect one shared recursive crafting plan for every requested item. Reports selected recipe trees, carried materials, missing leaf materials, and crafting-table requirements without crafting anything.";

export const viewCraftingRequirementsInputSchema = craftingRequestInputSchema;
export type ViewCraftingRequirementsRequest = CraftingRequest;
export const parseViewCraftingRequirementsRequest = parseCraftingRequest;

const requestedItemSchema = z.strictObject({
  item: z.string(),
  count: z.number().int().positive(),
});

export const craftingRequirementsEvidenceSchema = z.strictObject({
  items: z.array(requestedItemSchema).min(1),
  plan: craftPlanEvidenceSchema.optional(),
});

export const viewCraftingRequirementsResultSchema = actionResultSchema({
  requirements: craftingRequirementsEvidenceSchema,
});

export type ViewCraftingRequirementsResult = z.output<typeof viewCraftingRequirementsResultSchema>;
export type ViewCraftingRequirementsOutput = ActionOutput<
  typeof VIEW_CRAFTING_REQUIREMENTS,
  ViewCraftingRequirementsResult
>;

export const viewCraftingRequirementsAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const viewCraftingRequirementsOutcomes = {
  unknownItems: (items: readonly string[]) =>
    `[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: ${items.join(", ")}.`,
  plannerFailed: (items: readonly string[]) =>
    `[CRAFT_PLAN_UNAVAILABLE] The recursive planner found recipes but could not produce concrete plans for: ${items.join(", ")}.`,
} as const;
