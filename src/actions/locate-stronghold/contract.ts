import { z } from "zod";
import { actionResultSchema } from "../action.js";

export const LOCATE_STRONGHOLD = "locate_stronghold" as const;
export const LOCATE_STRONGHOLD_DESCRIPTION =
  "Locate an Overworld stronghold in two calls. phase: estimate (default) saves the initial Eye-of-Ender triangulation and returns success with approximate distance, walking time and recommended dragon-fight supplies, without travelling to the estimate. phase: locate reuses the same search_id, checks supplies, travels to the estimate, refines with a local eye throw and confirms loaded end_portal_frame blocks. Missing supplies require continue_without_recommended_items: true. Locate success does not mean entering the structure or activating its portal. Saved throws survive cancellation and restart. Attempts to recover nearby dropped eyes after throwing and on resume; shattered or unreachable eyes do not invalidate saved bearings. May dig; does not scaffold or gather other supplies.";

export const locateStrongholdInputSchema = z.strictObject({
  phase: z
    .enum(["estimate", "locate"])
    .default("estimate")
    .describe("Estimate first, then explicitly request locate with the same search_id."),
  continue_without_recommended_items: z
    .boolean()
    .default(false)
    .describe("Allow the locate phase despite missing recommended dragon-fight supplies."),
  search_id: z.string().trim().min(1).default("stronghold").describe("Durable search name within this bot and world."),
  search_radius: z
    .number()
    .int()
    .min(16)
    .default(128)
    .describe(
      "Horizontal radius in blocks to survey around the refined estimate if no portal frame is loaded there. Defaults to 128; an exhausted survey returns partial evidence.",
    ),
});
export type LocateStrongholdRequest = z.output<typeof locateStrongholdInputSchema>;
export const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export const estimateSchema = z.strictObject({ x: z.number().finite(), z: z.number().finite() });
export const locateStrongholdResultSchema = actionResultSchema({
  phase: z.enum(["estimate", "locate"]),
  journey: z
    .strictObject({
      horizontalDistanceBlocks: z.number().nonnegative(),
      walkingMinutes: z.number().nonnegative(),
      basis: z.literal(
        "Straight-line distance at 4.3 blocks/second; actual path, terrain, digging and stops are unknown.",
      ),
    })
    .nullable(),
  supplies: z.array(
    z.strictObject({ recommendation: z.string(), carried: z.number().nonnegative(), required: z.number().positive() }),
  ),
  searchId: z.string(),
  dimension: z.string(),
  throwIds: z.array(z.string()),
  estimate: estimateSchema.nullable(),
  confirmation: z.strictObject({ block: z.literal("end_portal_frame"), position: pointSchema }).nullable(),
});
export type LocateStrongholdResult = z.output<typeof locateStrongholdResultSchema>;
