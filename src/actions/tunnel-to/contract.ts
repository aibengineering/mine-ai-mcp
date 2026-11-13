/** MCP contract for digging a dry, walkable staircase down to a confirmed stronghold. */
import { z } from "zod";
import { actionResultSchema } from "../action.js";

export const TUNNEL_TO = "tunnel_to" as const;
export const TUNNEL_TO_DESCRIPTION =
  "Dig a dry, walkable diagonal staircase from the nearest dry shore down to a confirmed Overworld stronghold end-portal room, and leave the bot standing at the frame. For a stronghold buried under deep ocean, locate_stronghold confirms the frame from the surface far above but cannot reach it; tunnel_to plugs that gap. target defaults to the loaded end_portal_frame nearest the bot. The staircase never breaches water or lava: the movement policy refuses a dig that would open into either, so a route that cannot stay dry stops rather than flooding. Lava is a hard guard; silverfish-infested masonry is avoided where a dry break-in allows, and accepted up to a small budget otherwise. Writes two durable landmarks under the same search_id: the dry mouth where the staircase begins and the portal-room cell where it ends. May dig; places ladders on any vertical run and scaffold blocks from the survival policy. Does not activate or enter the portal, and does not return to the surface.";

export const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export type Point = z.output<typeof pointSchema>;

export const tunnelToInputSchema = z.strictObject({
  target: pointSchema
    .optional()
    .describe(
      "Block to reach, a walkable cell at the portal room. Defaults to a standable cell beside the loaded end_portal_frame nearest the bot.",
    ),
  search_id: z
    .string()
    .trim()
    .min(1)
    .default("stronghold")
    .describe("Durable search name; the mouth and portal-exit landmarks fold into this record, shared with locate_stronghold."),
  max_shore_distance: z
    .number()
    .int()
    .min(16)
    .default(256)
    .describe("Maximum horizontal blocks to search for dry land before giving up."),
  segment_length: z
    .number()
    .int()
    .min(4)
    .max(13)
    .default(13)
    .describe("Blocks per dig-hop. The full descent times out as one route, so it is dug in hops no longer than this."),
  silverfish_budget: z
    .number()
    .int()
    .min(0)
    .default(4)
    .describe("Infested blocks the break-in may accept before preferring a different face."),
});
export type TunnelToRequest = z.output<typeof tunnelToInputSchema>;

export const tunnelToResultSchema = actionResultSchema({
  target: pointSchema,
  arrived: pointSchema.nullable(),
  reachedTarget: z.boolean(),
  mouth: pointSchema.nullable(),
  portalExit: pointSchema.nullable(),
  shoreDistanceBlocks: z.number().nonnegative().nullable(),
  staircase: z.strictObject({
    segments: z.number().int().nonnegative(),
    descent: z.number().int().nonnegative(),
    laddersPlaced: z.number().int().nonnegative(),
  }),
  touchedWater: z.boolean(),
  touchedLava: z.boolean(),
  hazards: z.array(
    z.strictObject({
      kind: z.enum(["lava", "silverfish"]),
      position: pointSchema,
      action: z.enum(["rerouted", "avoided", "accepted"]),
    }),
  ),
});
export type TunnelToResult = z.output<typeof tunnelToResultSchema>;
