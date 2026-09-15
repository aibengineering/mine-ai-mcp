import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const PLACE_BLOCK = "place_block" as const;
export const PLACE_BLOCK_DESCRIPTION =
  "Place one carried block. With x, y, z it navigates into reach of that exact cell, which must be replaceable with adjacent solid support. Without them it picks the nearest clear cell within reach of where the bot stands that has a solid face to place against, floor first, then a wall, which is the way to put down a crafting table, furnace, or chest when the surroundings are unknown. Verifies the resulting block and inventory change.";

const coordinate = (axis: string) => z.number().int().safe().describe(`Absolute target block ${axis} coordinate.`);

export const placeBlockInputSchema = z.strictObject({
  block_name: registryNameSchema.describe("Exact block registry name carried as an item, such as cobblestone."),
  x: coordinate("X").optional(),
  y: coordinate("Y").optional(),
  z: coordinate("Z").optional(),
});

export interface PlaceBlockRequest {
  readonly blockName: string;
  /** Null when the action chooses the cell itself. */
  readonly target: { readonly x: number; readonly y: number; readonly z: number } | null;
}

export function parsePlaceBlockRequest(input: unknown): PlaceBlockRequest {
  const value = placeBlockInputSchema.parse(input ?? {});
  const given = [value.x, value.y, value.z].filter((axis) => axis !== undefined).length;
  if (given !== 0 && given !== 3)
    throw new Error("Give all of x, y, and z, or none of them to let the action choose the cell.");
  return {
    blockName: value.block_name,
    target:
      value.x !== undefined && value.y !== undefined && value.z !== undefined
        ? { x: value.x, y: value.y, z: value.z }
        : null,
  };
}

const positionSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

export const blockPlacementEvidenceSchema = z.strictObject({
  dimension: z.string(),
  requestedBlock: z.string(),
  target: positionSchema,
  beforeBlock: z.string().nullable(),
  afterBlock: z.string().nullable(),
  inventoryBefore: z.number().int().nonnegative(),
  inventoryAfter: z.number().int().nonnegative(),
  /** Whether `inventoryAfter` is the count the action expected; false when the server had not sent it in time. */
  confirmed: z.boolean(),
  placed: z.boolean(),
  support: positionSchema.optional(),
  face: positionSchema.optional(),
});

export const placeBlockResultSchema = actionResultSchema({
  placement: blockPlacementEvidenceSchema,
});

export type BlockPlacementEvidence = z.output<typeof blockPlacementEvidenceSchema>;
export type PlaceBlockResult = z.output<typeof placeBlockResultSchema>;
export type PlaceBlockOutput = ActionOutput<typeof PLACE_BLOCK, PlaceBlockResult>;

export const placeBlockOutcomesNearby = {
  noFreeCell:
    "[PLACE_NO_FREE_CELL] No clear cell with a solid face to place against within reach of the bot; move to open ground or dig a space first.",
} as const;

export const placeBlockAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const placeBlockOutcomes = {
  unknownBlock: (blockName: string) => `[PLACE_UNKNOWN_BLOCK] Minecraft has no block named ${blockName}.`,
  noItem: (blockName: string, available: number) =>
    `[PLACE_ITEM_MISSING] Bot inventory contains ${blockName} x${available}; placement requires one.`,
  routeStopped: (reason: string) => `[PLACE_UNREACHABLE] Pathfinder could not reach the target cell: ${reason}.`,
  targetUnloaded: "[PLACE_TARGET_UNLOADED] The target cell was not loaded after navigation.",
  targetOccupied: (blockName: string) =>
    `[PLACE_TARGET_OCCUPIED] The target cell contains ${blockName}, which this action will not remove.`,
  noSupport: "[PLACE_NO_SUPPORT] No adjacent solid block can support placement into the target cell.",
  failed: (reason: string) => `[PLACE_FAILED] Mineflayer could not place the requested block: ${reason}`,
} as const;
