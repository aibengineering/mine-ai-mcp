import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ActionOutput } from "../action.js";
import { sqlActionResultSchema } from "../sql-action.js";

export const VIEW_FRONTIER = "view_frontier" as const;
export const FRONTIER_MAP_PERSPECTIVES = ["biome", "surface_water", "all"] as const;
export const FRONTIER_MAP_SCALES = [1, 2, 4, 8, 16] as const;
export type FrontierMapScale = (typeof FRONTIER_MAP_SCALES)[number];

export const VIEW_FRONTIER_DESCRIPTION =
  "Render a bot-centred ASCII map of remembered chunks and their unexplored boundary. " +
  "Choose dominant biomes, surface-water coverage, or 'all' to include both perspectives. " +
  "Automatically picks the optimal zoom scale (chunks_per_cell) so remembered territory fits in view, or accepts an explicit scale (1, 2, 4, 8, 16). " +
  "Also returns the closest unexplored frontier chunk, its distance, and suggested heading in degrees. " +
  "Use query_bot_data when exact rows or custom SQL are more useful than a map.";

const oddDimension = (name: string, maximum: number, defaultValue: number) =>
  z
    .number()
    .int()
    .min(5)
    .max(maximum)
    .refine((value) => value % 2 === 1, `${name} must be odd so the bot has one centre cell`)
    .default(defaultValue)
    .describe(`Odd number of map cells. Defaults to ${defaultValue}; maximum ${maximum}.`);

export const viewFrontierInputSchema = z.strictObject({
  perspective: z
    .enum(FRONTIER_MAP_PERSPECTIVES)
    .default("biome")
    .describe(
      "Map colour: each cell's dominant biome, average surface-water coverage, or 'all' for both. Defaults to biome.",
    ),
  width: oddDimension("width", 121, 61),
  height: oddDimension("height", 81, 31),
  chunks_per_cell: z
    .number()
    .int()
    .refine((scale) => (FRONTIER_MAP_SCALES as readonly number[]).includes(scale), "unsupported map scale")
    .optional()
    .describe(
      "Chunk width and height represented by one character (1, 2, 4, 8, 16). Omit to automatically select the optimal zoom scale for remembered territory.",
    ),
});

export interface ViewFrontierRequest {
  readonly perspective: (typeof FRONTIER_MAP_PERSPECTIVES)[number];
  readonly width: number;
  readonly height: number;
  readonly chunksPerCell?: FrontierMapScale;
}

export function parseViewFrontierRequest(input: unknown): ViewFrontierRequest {
  const value = viewFrontierInputSchema.parse(input ?? {});
  return {
    perspective: value.perspective,
    width: value.width,
    height: value.height,
    chunksPerCell: value.chunks_per_cell as FrontierMapScale | undefined,
  };
}

export const closestFrontierSchema = z.strictObject({
  chunkX: z.number().int(),
  chunkZ: z.number().int(),
  distanceBlocks: z.number(),
  heading: z.number(),
});
export type ClosestFrontier = z.output<typeof closestFrontierSchema>;

export const frontierViewSchema = z.strictObject({
  perspective: z.enum(FRONTIER_MAP_PERSPECTIVES),
  dimension: z.string(),
  center: z.strictObject({
    blockX: z.number(),
    blockZ: z.number(),
    chunkX: z.number().int(),
    chunkZ: z.number().int(),
  }),
  closestFrontier: closestFrontierSchema.nullable(),
  window: z.strictObject({
    width: z.number().int(),
    height: z.number().int(),
    chunksPerCell: z.number().int(),
    minChunkX: z.number().int(),
    maxChunkX: z.number().int(),
    minChunkZ: z.number().int(),
    maxChunkZ: z.number().int(),
  }),
  map: z.string(),
  maps: z.record(z.string(), z.string()).optional(),
  legend: z.array(z.string()),
  legends: z.record(z.string(), z.array(z.string())).optional(),
});

export type ViewFrontierInput = z.input<typeof viewFrontierInputSchema>;
export type FrontierView = z.output<typeof frontierViewSchema>;

export const viewFrontierResultSchema = sqlActionResultSchema({
  view: frontierViewSchema,
});
export type ViewFrontierResult = z.output<typeof viewFrontierResultSchema>;
export type ViewFrontierOutput = ActionOutput<typeof VIEW_FRONTIER, ViewFrontierResult>;

export const viewFrontierAnnotations = {
  openWorldHint: false,
} satisfies ToolAnnotations;
