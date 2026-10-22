import { z } from "zod";
import { actionResultSchema } from "../action.js";
import {
  craftingOutcomes,
  craftPlanEvidenceSchema,
  craftingRequestInputSchema,
  type CraftingRequest,
} from "../crafting.js";

export const VIEW_CRAFTING_REQUIREMENTS = "view_crafting_requirements" as const;
export const VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION =
  "Inspect one shared recursive crafting plan for every requested item. Reports selected recipe trees, carried materials, missing leaf materials, and crafting-table requirements without crafting anything.";

export const viewCraftingRequirementsInputSchema = craftingRequestInputSchema;
export type ViewCraftingRequirementsRequest = CraftingRequest;

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

export const viewCraftingRequirementsOutcomes = craftingOutcomes;
