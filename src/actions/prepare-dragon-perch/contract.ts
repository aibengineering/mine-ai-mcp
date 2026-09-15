import { z } from "zod";

export const PREPARE_DRAGON_PERCH = "prepare_dragon_perch" as const;
export const PREPARE_DRAGON_PERCH_DESCRIPTION =
  "Prepare one low staging notch just outside the observed End exit fountain while the dragon is flying. Uses permitted digging and dragon-resistant scaffolding without swinging, opens a body-eye sightline and physically verifies a short ascent and return without construction before reporting ready. Retains the selected site across calls, but rechecks current access. Yields as soon as landing begins so attack_dragon_perch can pursue the head; unfinished preparation resumes during flight. Reports historical preparation and physical blockers. Clouds can obstruct the staging notch. Cancellation remains available while preparing.";

export const prepareDragonPerchInputSchema = z.strictObject({
  entity_id: z
    .number()
    .int()
    .nonnegative()
    .describe("Currently observed Ender Dragon entity ID."),
});

const preparedPositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const prepareDragonPerchCheckpointSchema = z.strictObject({
  preparedPosition: preparedPositionSchema.nullable(),
  stage: z.enum([
    "waiting",
    "preparing",
    "ready",
    "approaching_head",
    "attacking",
    "withdrawing",
  ]),
  blockedBy: z.string().nullable(),
});
