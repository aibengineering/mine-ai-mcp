/** MCP contract and factual outcomes for one absolute navigation request. */
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const NAVIGATE = "navigate" as const;
export const NAVIGATE_DESCRIPTION =
  "Navigate to one absolute block position using standard Pathfinder movements. Omit y for an unambiguous outdoor ground column; roofs, foliage, or multiple floors require an explicit y. A given y must be a cell the bot can stand in or loaded open water with sufficient air and a clear ascent to the surface; a mid-air y is refused unless build is true, in which case the bot scaffolds up to it on purpose. Active portal cells require enter_nether_portal or enter_end_portal. Underwater descent is slow, limiting how deep the bot can dive before needing air. Pathfinder may dig obstructions unless dig is false and place carried blocks from the survival policy's scaffold list unless scaffold is false. Disable both to preserve existing blocks along the route. Planned water-bucket drops up to 80 blocks are controlled separately by navigation.bucket_drops in the survival policy and require automatic water recovery before continuing.";

export const navigateInputSchema = z
  .strictObject({
    x: z.number().int().describe("Absolute target block X coordinate."),
    y: z
      .number()
      .int()
      .optional()
      .describe(
        "Absolute target feet-block Y coordinate. Omit it only for unambiguous outdoor ground. Roofs, foliage, and multiple floors require y to choose a known floor, ledge, or tunnel.",
      ),
    z: z.number().int().describe("Absolute target block Z coordinate."),
    range: z
      .number()
      .nonnegative()
      .default(1)
      .describe("Euclidean distance between Pathfinder block nodes that counts as reached. Defaults to 1 block."),
    dig: z
      .boolean()
      .default(true)
      .describe(
        "Allow blocks to be broken for the route. False forbids excavation; doors and gates can still be opened and restored after passage.",
      ),
    scaffold: z
      .boolean()
      .default(true)
      .describe(
        "Allow carried blocks from the survival policy's scaffold list to be placed for the route. False keeps the bot on existing terrain or in water.",
      ),
    build: z
      .boolean()
      .default(false)
      .describe(
        "Accept a target with nothing to stand on and scaffold up to it deliberately, for example to build a lookout or reach a floating structure. Off by default because a mid-air y usually means the surface height was guessed; the bot can dig its way back down a pillar it built.",
      ),
  });

export interface NavigateRequest {
  readonly x: number;
  /** Null asks for the ground at x,z at any height. */
  readonly y: number | null;
  readonly z: number;
  readonly range: number;
  readonly scaffold: boolean;
  readonly dig: boolean;
  /** The caller means to end on scaffolding it places: a mid-air target is accepted. */
  readonly build: boolean;
}

export function parseNavigateRequest(input: unknown): NavigateRequest {
  const value = navigateInputSchema.parse(input ?? {});
  return {
    x: value.x,
    y: value.y ?? null,
    z: value.z,
    range: value.range,
    scaffold: value.scaffold,
    dig: value.dig,
    build: value.build,
  };
}

const positionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** The requested target; `y` is null when the request asked for the ground at x,z. */
const targetSchema = z.strictObject({
  x: z.number(),
  y: z.number().nullable(),
  z: z.number(),
});

const scaffoldStockSchema = z.strictObject({
  item: z.string(),
  inventoryBefore: z.number().int().nonnegative(),
  inventoryAfter: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
});

export const navigationEvidenceSchema = z.strictObject({
  startDimension: z.string(),
  endDimension: z.string(),
  target: targetSchema,
  range: z.number().nonnegative(),
  start: positionSchema,
  end: positionSchema,
  remainingDistance: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Distance to the target in the source dimension; null after a dimension change."),
  elapsedMs: z.number().int().nonnegative(),
  scaffolding: z.array(scaffoldStockSchema),
  bucketDrops: z.strictObject({ count: z.number().int().nonnegative(), waterRecovered: z.number().int().nonnegative() }).describe("Planned bucket pours and independently confirmed water recoveries during this request."),
  missingDigTools: z
    .array(z.enum(["shovel", "pickaxe", "axe"]))
    .describe("Tool types absent from inventory when reporting navigation; empty when digging is disabled."),
});

export const navigateResultSchema = actionResultSchema({
  navigation: navigationEvidenceSchema,
});

export type NavigationEvidence = z.output<typeof navigationEvidenceSchema>;
export type NavigateResult = z.output<typeof navigateResultSchema>;
export type NavigateOutput = ActionOutput<typeof NAVIGATE, NavigateResult>;

export const navigateOutcomes = {
  toolTierLost: (reason: string) => reason,
  stopped: (reason: string) => `[NAVIGATION_STOPPED] Pathfinder stopped: ${reason}.`,
  targetOnWater: (target: { x: number; z: number }, radius: number) =>
    `[NAVIGATION_TARGET_WATER] The ground at ${target.x}, ${target.z} is water, and no dry ground the bot can stand on lies within ${radius} blocks of it; a ground target on a lake sends the bot to the lake bed.`,
  unsupportedTarget: (target: { x: number; y: number; z: number }, range: number, ground: number | null) =>
    `[NAVIGATION_TARGET_UNSUPPORTED] No usable footing was observed within ${range} blocks of ${target.x}, ${target.y}, ${target.z}. ${
      ground === null
        ? "No ground was found within 64 blocks below it."
        : `The ground in that column is at y=${ground}.`
    } Choose an observed supported height, or pass build: true to scaffold to this point deliberately.`,
  dimensionChanged: (from: string, to: string) =>
    `[NAVIGATION_DIMENSION_CHANGED] Navigation started in ${from} but ended in ${to}.`,
  incomplete: (remaining: number, range: number) =>
    `[NAVIGATION_INCOMPLETE] Pathfinder completed but its final node remained ${remaining.toFixed(2)} blocks from a ${range}-block target range.`,
  executionFailed: (cause: unknown) =>
    `[NAVIGATION_FAILED] Pathfinder threw: ${cause instanceof Error ? cause.message : String(cause)}`,
} as const;
