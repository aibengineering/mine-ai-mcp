import { z } from "zod";
import type { CraftMaterial, CraftPlanEvidence, CraftStep } from "../utils/craft-plan.js";
import { registryNameSchema } from "./registry-name.js";

export type { CraftMaterial, CraftPlanEvidence, CraftStep } from "../utils/craft-plan.js";

const requestedCraftItemSchema = z.strictObject({
  item_name: registryNameSchema.describe("Registry item name, such as stick or stone_pickaxe."),
  count: z.number().int().positive().safe().default(1).describe("How many new items to craft."),
});

export const craftingRequestInputSchema = z.strictObject({
  items: z
    .array(requestedCraftItemSchema)
    .min(1)
    .refine((items) => {
      const totals = new Map<string, number>();
      for (const item of items) {
        const total = (totals.get(item.item_name) ?? 0) + item.count;
        if (!Number.isSafeInteger(total)) return false;
        totals.set(item.item_name, total);
      }
      return true;
    }, "Combined item counts must remain safe integers."),
});

export interface RequestedCraftItem {
  readonly itemName: string;
  readonly count: number;
}

export interface CraftingRequest {
  readonly items: readonly RequestedCraftItem[];
}

export function parseCraftingRequest(input: unknown): CraftingRequest {
  const parsed = craftingRequestInputSchema.parse(input ?? {});
  const combined = new Map<string, number>();
  for (const item of parsed.items) {
    combined.set(item.item_name, (combined.get(item.item_name) ?? 0) + item.count);
  }
  return { items: [...combined].map(([itemName, count]) => ({ itemName, count })) };
}

export const craftMaterialSchema: z.ZodType<CraftMaterial> = z.strictObject({
  item: z.string(),
  count: z.number().int().positive(),
});

export const craftStepSchema: z.ZodType<CraftStep> = z.strictObject({
  item: z.string(),
  count: z.number().int().positive(),
  applications: z.number().int().positive(),
  ingredients: z.array(craftMaterialSchema),
  requiresCraftingTable: z.boolean(),
});

export const craftPlanEvidenceSchema: z.ZodType<CraftPlanEvidence> = z.strictObject({
  status: z.enum(["ready", "missing_materials", "uncraftable", "planner_failed"]),
  steps: z.array(craftStepSchema),
  requiredMaterials: z.array(craftMaterialSchema),
  carriedMaterials: z.array(craftMaterialSchema),
  missingMaterials: z.array(craftMaterialSchema),
  requiresCraftingTable: z.boolean(),
  tree: z.string(),
});
