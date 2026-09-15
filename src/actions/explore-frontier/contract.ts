/** MCP schemas and factual outcome wording for frontier exploration. */
import { z } from "zod";
import type { ActionOutput } from "../action.js";
import { sqlActionResultSchema } from "../sql-action.js";

export const EXPLORE_FRONTIER = "explore_frontier" as const;
export const EXPLORE_FRONTIER_DESCRIPTION =
  "Extend the remembered world frontier in a directional heading in degrees (0 = North, 90 = East, 180 = South, 270 = West) through short routes; standard movements (digging and scaffolding) are enabled to navigate terrain. Optionally stop when the requested biome is observed at the grounded bot's feet; loaded or remembered biome columns alone do not count as entry. The bot stays where exploration stops.";
export const MAX_EXPLORE_CHUNKS = 8;

export const exploreFrontierInputSchema = z.strictObject({
  heading: z
    .number()
    .min(0)
    .max(360)
    .describe(
      "Compass heading in degrees clockwise from North (0 = North, 90 = East, 180 = South, 270 = West; 360 = North). Any angle 0..360 is supported.",
    ),
  chunks: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXPLORE_CHUNKS)
    .default(1)
    .describe("Chunk columns by which to extend that directional map boundary. Defaults to 1."),
  biome: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Minecraft biome registry name, such as warped_forest. Succeed only when this biome is observed at the grounded bot's feet, including at the start. Stop without success if the requested chunk-boundary expansion is exhausted first.",
    ),
});

export interface ExploreFrontierRequest {
  readonly heading: number;
  readonly chunks: number;
  readonly biome?: string;
}

export function parseExploreFrontierRequest(input: unknown): ExploreFrontierRequest {
  const value = exploreFrontierInputSchema.parse(input ?? {});
  return { heading: value.heading, chunks: value.chunks, ...(value.biome !== undefined && { biome: value.biome }) };
}

export interface UnitVector {
  readonly x: number;
  readonly z: number;
}

export function unitVectorForHeading(headingDegrees: number): UnitVector {
  const radians = (headingDegrees * Math.PI) / 180;
  const rawX = Math.sin(radians);
  const rawZ = -Math.cos(radians);
  return {
    x: Math.abs(rawX) < 1e-12 ? 0 : rawX,
    z: Math.abs(rawZ) < 1e-12 ? 0 : rawZ,
  };
}

export function headingForVector(x: number, z: number): number {
  const degrees = (Math.atan2(x, -z) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(normalized * 10) / 10;
  return rounded === 360 || Object.is(rounded, -0) ? 0 : rounded;
}

const positionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const nearestFrontierSchema = z.strictObject({
  chunkX: z.number().int(),
  chunkZ: z.number().int(),
  distanceBlocks: z.number(),
  heading: z.number(),
});
export type NearestFrontier = z.output<typeof nearestFrontierSchema>;

const explorationEvidenceSchema = z.strictObject({
  dimension: z.string(),
  heading: z.number(),
  requestedChunks: z.number().int().min(1).max(MAX_EXPLORE_CHUNKS),
  expandedChunks: z.number().int().nonnegative(),
  newChunksRecorded: z.number().int().nonnegative(),
  start: positionSchema,
  end: positionSchema,
  nearestFrontier: nearestFrontierSchema.nullable(),
  biome: z
    .discriminatedUnion("status", [
      z.strictObject({ status: z.literal("entered"), name: z.string(), position: positionSchema }),
      z.strictObject({ status: z.literal("not_observed"), name: z.string() }),
    ])
    .optional()
    .describe(
      "Entry is an actual biome observation at the grounded bot's feet, not a loaded column or predicted destination.",
    ),
});

export const exploreFrontierResultSchema = sqlActionResultSchema({
  explored: explorationEvidenceSchema,
});

export type ExploreFrontierResult = z.output<typeof exploreFrontierResultSchema>;
export type ExploreFrontierOutput = ActionOutput<
  typeof EXPLORE_FRONTIER,
  ExploreFrontierResult
>;

export const exploreOutcomes = {
  emptyFrontier: (dimension: string) =>
    `[FRONTIER_EMPTY] No committed chunks are available in ${dimension}; exploration did not start.`,
  frontierError: (error: string) => `[FRONTIER_UNAVAILABLE] Frontier recording reported: ${error}`,
  routeStopped: (reason: string) => `[EXPLORATION_ROUTE_STOPPED] Pathfinder stopped: ${reason}.`,
  noForwardProgress: (heading: number) =>
    `[EXPLORATION_NO_FORWARD_PROGRESS] The completed Pathfinder leg made no measurable progress heading ${heading}°.`,
  dimensionChanged: (from: string, to: string) =>
    `[EXPLORATION_DIMENSION_CHANGED] Exploration started in ${from} but the bot is now in ${to}.`,
  executionFailed: (cause: unknown) =>
    `[EXPLORATION_FAILED] Pathfinder threw: ${cause instanceof Error ? cause.message : String(cause)}`,
  boundaryNotReached: (expanded: number, requested: number) =>
    `[EXPLORATION_INCOMPLETE] The bounded route expanded ${expanded}/${requested} requested frontier chunk columns.`,
  unknownBiome: (biome: string) => `[EXPLORATION_UNKNOWN_BIOME] Minecraft has no biome registry entry named ${biome}.`,
  biomeNotObserved: (biome: string, expanded: number, requested: number) =>
    `[EXPLORATION_BIOME_NOT_OBSERVED] The route expanded ${expanded}/${requested} requested frontier chunk columns without observing ${biome} at the grounded bot's feet.`,
} as const;
