import { temporaryWorkstationInputSchema, workstationEvidenceSchema } from "../temporary-workstation.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const SMELT_ITEM = "smelt_item" as const;
export const SMELT_ITEM_DESCRIPTION =
  "Smelt an exact carried input count using an explicit carried fuel. Supply an empty furnace's coordinates, or temporary_workstation=true to place and recover a carried furnace. Navigates into reach, follows observed furnace cook and fuel progress, and gives up only on fuel starvation, a true progress stall, or an outer safety limit. Residual slots are recovered with bounded waits and the result reports cooked output plus raw input and fuel actually recovered.";

export const smeltItemInputSchema = z
  .strictObject({
    temporary_workstation: temporaryWorkstationInputSchema,
    item_name: registryNameSchema.describe("Exact carried furnace input registry name, such as raw_iron."),
    count: z.number().int().positive().max(64).describe("Exact input count, bounded by the furnace input slot."),
    fuel_item_name: registryNameSchema.describe("Exact carried fuel registry name, such as coal."),
    x: z.number().int().safe().optional().describe("Furnace block X coordinate."),
    y: z.number().int().safe().optional().describe("Furnace block Y coordinate."),
    z: z.number().int().safe().optional().describe("Furnace block Z coordinate."),
  })
  .superRefine((value, context) => {
    const coordinates = [value.x, value.y, value.z];
    const invalid = value.temporary_workstation
      ? coordinates.some((coordinate) => coordinate !== undefined)
      : coordinates.some((coordinate) => coordinate === undefined);
    if (invalid)
      context.addIssue({
        code: "custom",
        message: "Provide x, y, and z for an existing furnace, or temporary_workstation=true without coordinates.",
      });
  });

interface SmeltItems {
  readonly itemName: string;
  readonly count: number;
  readonly fuelItemName: string;
}

export type ExistingFurnaceRequest = SmeltItems & { readonly x: number; readonly y: number; readonly z: number };
export type SmeltItemRequest = SmeltItems &
  (
    | { readonly temporaryWorkstation: true }
    | { readonly temporaryWorkstation?: false; readonly x: number; readonly y: number; readonly z: number }
  );

export function parseSmeltItemRequest(input: unknown): SmeltItemRequest {
  const value = smeltItemInputSchema.parse(input ?? {});
  const items = {
    itemName: value.item_name,
    count: value.count,
    fuelItemName: value.fuel_item_name,
  };
  return value.temporary_workstation
    ? { ...items, temporaryWorkstation: true }
    : { ...items, x: value.x!, y: value.y!, z: value.z! };
}

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

export const smeltEvidenceSchema = z.strictObject({
  dimension: z.string(),
  furnace: positionSchema.nullable(),
  inputItem: z.string(),
  fuelItem: z.string(),
  requested: z.number().int().positive(),
  fuelInserted: z.number().int().nonnegative(),
  outputItem: z.string().nullable(),
  produced: z.number().int().nonnegative(),
  inputInventoryBefore: z.number().int().nonnegative(),
  inputInventoryAfter: z.number().int().nonnegative(),
  fuelInventoryBefore: z.number().int().nonnegative(),
  fuelInventoryAfter: z.number().int().nonnegative(),
  rawRecovered: z.number().int().nonnegative(),
  fuelRecovered: z.number().int().nonnegative(),
  finalCookProgress: z.number().min(0).max(1).nullable(),
  finalFuelProgress: z.number().min(0).max(1).nullable(),
});

export const smeltItemResultSchema = actionResultSchema({
  smelt: smeltEvidenceSchema,
  workstation: workstationEvidenceSchema.optional(),
});
export type SmeltEvidence = z.output<typeof smeltEvidenceSchema>;
export type SmeltItemResult = z.output<typeof smeltItemResultSchema>;
export type SmeltItemOutput = ActionOutput<typeof SMELT_ITEM, SmeltItemResult>;

export const smeltItemAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const smeltItemOutcomes = {
  unknownItem: (item: string) => `[UNKNOWN_SMELT_ITEM] Minecraft has no item registry entry named ${item}.`,
  unsupportedFuel: (fuel: string) => `[SMELT_FUEL_UNSUPPORTED] ${fuel} is not a supported furnace fuel.`,
  inputMissing: (item: string, available: number, requested: number) =>
    `[SMELT_INPUT_MISSING] Bot inventory contains ${item} x${available}; smelting requested x${requested}.`,
  fuelMissing: (fuel: string, available: number, required: number) =>
    `[SMELT_FUEL_MISSING] Bot inventory contains ${fuel} x${available}; this cook requires x${required}.`,
  routeStopped: (reason: string) => `[FURNACE_UNREACHABLE] Pathfinder could not reach the furnace: ${reason}.`,
  blockUnloaded: "[FURNACE_BLOCK_UNLOADED] The exact furnace cell was not loaded after navigation.",
  furnaceMissing: (block: string) => `[FURNACE_NOT_PRESENT] The exact station cell contains ${block}, not a furnace.`,
  openFailed: (cause: unknown) =>
    `[FURNACE_OPEN_FAILED] Mineflayer could not open the furnace: ${cause instanceof Error ? cause.message : String(cause)}`,
  occupied: (slots: readonly string[]) =>
    `[FURNACE_NOT_EMPTY] The furnace has pre-existing ${slots.join(", ")}; nothing was inserted.`,
  executionFailed: (cause: unknown) =>
    `[SMELT_EXECUTION_FAILED] The furnace transaction stopped: ${cause instanceof Error ? cause.message : String(cause)}`,
  stalled: (produced: number, requested: number, raw: number, fuel: number, progress: number | null) =>
    `[SMELT_STALLED] Furnace cook progress stopped at ${progress === null ? "unknown" : `${Math.round(progress * 100)}%`}; retrieved ${produced}/${requested} cooked, ${raw} raw, and ${fuel} fuel.`,
  fuelStarved: (produced: number, requested: number, raw: number, fuel: number) =>
    `[SMELT_FUEL_STARVED] Furnace fuel was exhausted with input remaining; retrieved ${produced}/${requested} cooked, ${raw} raw, and ${fuel} fuel.`,
  safetyTimeout: (produced: number, requested: number, raw: number, fuel: number, progress: number | null) =>
    `[SMELT_SAFETY_TIMEOUT] Furnace transaction reached its outer safety limit at ${progress === null ? "unknown progress" : `${Math.round(progress * 100)}% progress`}; retrieved ${produced}/${requested} cooked, ${raw} raw, and ${fuel} fuel.`,
} as const;
