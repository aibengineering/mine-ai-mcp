import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ActionOutput } from "../action.js";
import type { Position3 } from "../../utils/index.js";

export const SLEEP = "sleep" as const;

export const SLEEP_DESCRIPTION =
  "Rest in a bed to sleep through the night or set your respawn point. Automatically finds the nearest unoccupied bed or places one from inventory if carried.";

export const bedPositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const otherPlayerSleepSchema = z.strictObject({
  username: z.string(),
  sleepState: z.enum(["sleeping", "awake", "unknown"]),
});

export const nearbySleepHostileSchema = z.strictObject({
  name: z.string(),
  distance: z.number().nonnegative(),
  position: bedPositionSchema,
});

export const sleepInputSchema = z.strictObject({});

export const sleepEvidenceSchema = z.strictObject({
  asleep: z.boolean(),
  morning: z.boolean(),
  respawnSet: z.boolean(),
  timeOfDay: z.number(),
  ticksUntilNight: z.number().nonnegative().optional(),
  minutesUntilNight: z.number().nonnegative().optional(),
  placedBed: z.boolean(),
  bedPosition: bedPositionSchema.optional(),
  otherPlayers: z.array(otherPlayerSleepSchema).optional(),
  nearbyHostiles: z.array(nearbySleepHostileSchema).optional(),
  observation: z.string(),
  warning: z.string().optional(),
});

export type SleepEvidence = z.output<typeof sleepEvidenceSchema>;
export type SleepResult =
  | { status: "succeeded"; sleep: SleepEvidence }
  | { status: "partial"; error: string; sleep: SleepEvidence }
  | { status: "failed"; error: string; sleep?: SleepEvidence };

export const sleepResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), sleep: sleepEvidenceSchema }),
  z.strictObject({ status: z.literal("partial"), error: z.string(), sleep: sleepEvidenceSchema }),
  z.strictObject({ status: z.literal("failed"), error: z.string(), sleep: sleepEvidenceSchema.optional() }),
]) as z.ZodType<SleepResult, SleepResult>;

export const sleepAnnotations = {
  openWorldHint: false,
} satisfies ToolAnnotations;

export const sleepOutcomes = {
  dimensionUnsafe: "[BED_DIMENSION_UNSAFE] Beds explode in the Nether and the End.",
  alreadySleeping: "Bot is already sleeping in a bed.",
  noBedFound:
    "[BED_NOT_FOUND] No unoccupied bed found within 32 blocks and no bed carried in inventory. Gather 3 wool (from sheep) and 3 wood planks to craft a bed.",
  placementFailed: (reason: string) => `[BED_PLACEMENT_FAILED] ${reason}`,
  unreachable: (position: Position3, cause: string) =>
    `[BED_UNREACHABLE] Could not navigate to bed at ${position.x},${position.y},${position.z}: ${cause}`,
  daytimeRespawnSet: (timeOfDay: number) =>
    `Respawn point set at the bed, but daytime prevents sleeping (time is ${timeOfDay}).`,
  respawnRejected: (reason: string) => `[BED_RESPAWN_REJECTED] ${reason}`,
  sleepRejected: (reason: string) => `[BED_SLEEP_REJECTED] ${reason}`,
  sleepRejectedObservation: (reason: string) => `Could not enter bed: ${reason}`,
  hostilesNearby: (hostiles: readonly { name: string; distance: number }[]) =>
    `[BED_HOSTILES_NEARBY] Minecraft will not allow sleep while these hostile mobs are near the bed: ${hostiles
      .map((hostile) => `${hostile.name} (${hostile.distance.toFixed(2)} blocks)`)
      .join(", ")}.`,
  sleptMorning: "Slept through the night and woke up in the morning.",
  restingInBed: "Resting in bed; waiting for night to advance.",
  wokeUp: "Woke up from bed.",
  noBedInInventory: (bedName: string, position: Position3) =>
    `No bed remains in inventory. If travel is planned and coordinating sleep with others is more important than retaining this respawn point, collect the ${bedName} at ${position.x},${position.y},${position.z} afterward with collect_block.`,
} as const;

export type SleepInput = z.input<typeof sleepInputSchema>;
export type SleepRequest = Record<string, never>;
export type SleepOutput = ActionOutput<typeof SLEEP, SleepResult>;

export function parseSleepRequest(raw: unknown): SleepRequest {
  sleepInputSchema.parse(raw ?? {});
  return {};
}
