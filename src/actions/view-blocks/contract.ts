import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const VIEW_BLOCKS = "view_blocks" as const;

export const VIEW_BLOCKS_DESCRIPTION =
  "View blocks without moving. find lists, for each named block kind, the nearest ones across every loaded chunk with their distance and what is above and below. " +
  "box reads every cell of a small box around a point as one grid per layer. cells reads exact cells. " +
  "Each reports the block name and whether it is solid, open, or liquid, and a liquid's source or flowing level. " +
  "Use it to locate obsidian, water, lava, ore, or chests before acting, and to see what is under and around the bot or a target.";

/**
 * How many find hits are listed per name. Twelve covers a portal's worth of
 * obsidian or every chest at a base in one read; the count found is reported
 * whatever the limit, and a caller can raise it to sixty-four, past which a
 * list stops being readable. Per name, because a world holds tens of thousands
 * of lava blocks and a handful of obsidian, and one nearest-first list would
 * be all lava.
 */
export const DEFAULT_FIND_LIMIT = 12;
export const MAX_FIND_LIMIT = 64;
/** How many kinds one find may name; more than a handful is a query, not a look. */
export const MAX_FIND_NAMES = 8;
/**
 * A box is drawn as one grid per layer, so its size is bounded by what reads
 * as a picture: nine across at most, and seven layers at most, 567 cells.
 */
export const MAX_BOX_HALF_WIDTH = 4;
export const MAX_BOX_HALF_HEIGHT = 3;
/** Exact cells are the bot's own choice; thirty-two is a whole small structure. */
export const MAX_CELLS = 32;

const coordinate = (axis: string) => z.number().int().safe().describe(`Absolute ${axis} coordinate.`);

export const findRequestSchema = z.strictObject({
  block_names: z
    .array(registryNameSchema)
    .min(1)
    .max(MAX_FIND_NAMES)
    .describe(
      "Block registry names to look for, such as obsidian or chest; log and ore names also match their deepslate or wood variants.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_FIND_LIMIT)
    .default(DEFAULT_FIND_LIMIT)
    .describe("How many of the nearest hits to list per name; the count found is always reported."),
});

export const boxRequestSchema = z.strictObject({
  x: coordinate("X"),
  y: coordinate("Y"),
  z: coordinate("Z"),
  half_width: z
    .number()
    .int()
    .min(1)
    .max(MAX_BOX_HALF_WIDTH)
    .default(2)
    .describe("Blocks either side of the centre along x and z."),
  half_height: z
    .number()
    .int()
    .min(0)
    .max(MAX_BOX_HALF_HEIGHT)
    .default(1)
    .describe("Layers above and below the centre."),
});

export const cellRequestSchema = z.strictObject({ x: coordinate("X"), y: coordinate("Y"), z: coordinate("Z") });

export const viewBlocksInputSchema = z.strictObject({
  find: findRequestSchema.optional().describe("The nearest blocks of these kinds, anywhere loaded."),
  box: boxRequestSchema.optional().describe("Every cell of a box around a point, drawn layer by layer."),
  cells: z.array(cellRequestSchema).min(1).max(MAX_CELLS).optional().describe("Exact cells to read."),
});

export type ViewBlocksInput = z.input<typeof viewBlocksInputSchema>;

export interface ViewBlocksRequest {
  readonly find: { readonly blockNames: readonly string[]; readonly limit: number } | null;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly halfWidth: number;
    readonly halfHeight: number;
  } | null;
  readonly cells: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

export function parseViewBlocksRequest(raw: unknown): ViewBlocksRequest {
  const value = viewBlocksInputSchema.parse(raw ?? {});
  if (!value.find && !value.box && !value.cells) throw new Error("A view needs find, box, or cells.");
  return {
    find: value.find ? { blockNames: [...new Set(value.find.block_names)], limit: value.find.limit } : null,
    box: value.box
      ? {
          x: value.box.x,
          y: value.box.y,
          z: value.box.z,
          halfWidth: value.box.half_width,
          halfHeight: value.box.half_height,
        }
      : null,
    cells: value.cells ?? [],
  };
}

/** Whether a cell can be walked through, stood on, or swum in. */
export const BLOCK_SHAPES = ["solid", "open", "liquid"] as const;

export const observedBlockSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  name: z.string(),
  shape: z.enum(BLOCK_SHAPES),
  /** A liquid's level: 0 is a source, higher is flowing and thinner. */
  level: z.number().int().nonnegative().optional(),
  waterlogged: z.boolean().optional(),
});

export const foundBlockSchema = observedBlockSchema.extend({
  distance: z.number().nonnegative(),
  above: z.string(),
  below: z.string(),
});

export const viewBlocksReportSchema = z.strictObject({
  dimension: z.string(),
  feet: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  /** Loaded chunk columns, which is the extent a find covers. */
  loadedChunks: z.number().int().nonnegative(),
  /** One entry per name asked for, in the order asked. */
  find: z
    .array(
      z.strictObject({
        name: z.string(),
        /** Matching blocks loaded, before the limit. */
        found: z.number().int().nonnegative(),
        listed: z.array(foundBlockSchema),
      }),
    )
    .nullable(),
  box: z
    .strictObject({
      center: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
      halfWidth: z.number().int(),
      halfHeight: z.number().int(),
      /** One row per z, one entry per x, top layer first. */
      layers: z.array(
        z.strictObject({
          y: z.number().int(),
          rows: z.array(z.strictObject({ z: z.number().int(), blocks: z.array(z.string()) })),
        }),
      ),
    })
    .nullable(),
  cells: z.array(observedBlockSchema),
});

export type ObservedBlock = z.output<typeof observedBlockSchema>;
export type FoundBlock = z.output<typeof foundBlockSchema>;
export type ViewBlocksReport = z.output<typeof viewBlocksReportSchema>;

export const viewBlocksResultSchema = actionResultSchema({ blocks: viewBlocksReportSchema });
export type ViewBlocksResult = z.output<typeof viewBlocksResultSchema>;
export type ViewBlocksOutput = ActionOutput<typeof VIEW_BLOCKS, ViewBlocksResult>;

export const viewBlocksAnnotations = {
  openWorldHint: false,
} satisfies ToolAnnotations;

export const viewBlocksOutcomes = {
  unknownBlock: (blockName: string) => `[VIEW_UNKNOWN_BLOCK] Minecraft has no block named ${blockName}.`,
} as const;
