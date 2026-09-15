import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const USE_BUCKET = "use_bucket" as const;
export const USE_BUCKET_DESCRIPTION =
  "Fill a carried bucket from a water or lava source, or pour a full bucket into one exact cell. A fill without a cell finds the nearest source the way mining finds ore: every loaded column is searched, and when nothing is loaded the bot explores outward for a bounded time before reporting that it found none. A fill that names a flowing cell scoops the source feeding it when one is within a few cells. Navigates into reach and verifies the bucket and the world changed. To obtain obsidian, ask collect_block for it while carrying a water bucket: the mining process pours onto lava itself.";

export const bucketLiquidSchema = z.enum(["water", "lava"]);
export type BucketLiquid = z.output<typeof bucketLiquidSchema>;

const coordinate = (axis: string) =>
  z.number().int().safe().describe(`Absolute ${axis} coordinate of the target cell.`);

export const useBucketInputSchema = z.strictObject({
  action: z
    .enum(["fill", "pour"])
    .describe("fill scoops a source into an empty bucket; pour empties a full bucket into the named cell."),
  liquid: bucketLiquidSchema
    .default("water")
    .describe("Which liquid to scoop, or which full bucket to pour. Defaults to water."),
  x: coordinate("X").optional(),
  y: coordinate("Y").optional(),
  z: coordinate("Z").optional(),
});

export interface BucketCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type UseBucketRequest =
  | { readonly action: "fill"; readonly liquid: BucketLiquid; readonly cell: BucketCell | null }
  | { readonly action: "pour"; readonly liquid: BucketLiquid; readonly cell: BucketCell };

export function parseUseBucketRequest(input: unknown): UseBucketRequest {
  const value = useBucketInputSchema.parse(input ?? {});
  const named = [value.x, value.y, value.z].filter((part) => part !== undefined).length;
  if (named !== 0 && named !== 3) {
    throw new Error("A target cell needs all three of x, y, and z.");
  }
  const cell = named === 3 ? { x: value.x!, y: value.y!, z: value.z! } : null;
  if (value.action === "pour") {
    if (!cell) throw new Error("pour needs the x, y, and z of the cell the liquid should end up in.");
    return { action: "pour", liquid: value.liquid, cell };
  }
  return { action: "fill", liquid: value.liquid, cell };
}

const positionSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

export const bucketUseEvidenceSchema = z.strictObject({
  dimension: z.string(),
  action: z.enum(["fill", "pour"]),
  liquid: bucketLiquidSchema,
  /** The source scooped from, or the cell poured into. */
  target: positionSchema.nullable(),
  targetBefore: z.string().nullable(),
  targetAfter: z.string().nullable(),
  /** The solid face a pour was aimed at. */
  aimedAt: positionSchema.optional(),
  heldBefore: z.string().nullable(),
  heldAfter: z.string().nullable(),
  /** Lava sources that became obsidian, and flowing lava that became cobblestone, within ten blocks of a pour. */
  obsidianFormed: z.number().int().nonnegative(),
  cobblestoneFormed: z.number().int().nonnegative(),
  used: z.boolean(),
  /** Whether the fill had to explore beyond the loaded scan to find a source. */
  explored: z.boolean().optional(),
});

export const useBucketResultSchema = actionResultSchema({
  bucket: bucketUseEvidenceSchema,
});

export type BucketUseEvidence = z.output<typeof bucketUseEvidenceSchema>;
export type UseBucketResult = z.output<typeof useBucketResultSchema>;
export type UseBucketOutput = ActionOutput<typeof USE_BUCKET, UseBucketResult>;

export const useBucketAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const useBucketOutcomes = {
  noBucket: (name: string) => `[BUCKET_MISSING] Bot inventory holds no ${name}.`,
  noSource: (liquid: string, explored: string | null) =>
    `[BUCKET_NO_SOURCE] No ${liquid} source in any loaded column` +
    (explored ? `, and exploring found none (${explored})` : "") +
    "; explore the frontier, or move, and try again.",
  notASource: (liquid: string, found: string) =>
    `[BUCKET_NOT_A_SOURCE] The named cell holds ${found}, not a ${liquid} source; a bucket only scoops sources.`,
  routeStopped: (reason: string) => `[BUCKET_UNREACHABLE] Pathfinder could not reach the target: ${reason}.`,
  targetUnloaded: "[BUCKET_TARGET_UNLOADED] The target cell was not loaded after navigation.",
  targetOccupied: (name: string) =>
    `[BUCKET_TARGET_OCCUPIED] The target cell holds ${name}; a bucket pours only into air or something a liquid replaces.`,
  noFace: "[BUCKET_NO_FACE] No solid block beside the target cell faces the bot, so there is nothing to pour against.",
  failed: (reason: string) => `[BUCKET_FAILED] The bucket use did not take effect: ${reason}`,
  noLineOfSight:
    "[BUCKET_NO_LINE_OF_SIGHT] After navigation, no source was visible within bucket reach from supported dry ground above it. No bucket use was attempted.",
} as const;
