import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const CANCEL_FOREGROUND_ACTION = "cancel_foreground_action" as const;
export const CANCEL_FOREGROUND_ACTION_DESCRIPTION =
  "Cancel the currently running foreground action and release the session when that action observes cancellation. This control action remains callable while the foreground session is busy.";

export const cancelForegroundActionInputSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .default("cancelled by cancel_foreground_action")
    .describe("Why the active foreground action should stop."),
});

export const foregroundCancellationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cancellation_requested"),
    action: z.string(),
    startedAt: z.string(),
    reason: z.string(),
  }),
  z.strictObject({ kind: z.literal("idle"), reason: z.string() }),
]);

export const cancelForegroundActionResultSchema = actionResultSchema({
  cancellation: foregroundCancellationSchema,
});

export type CancelForegroundActionRequest = z.output<typeof cancelForegroundActionInputSchema>;
export type CancelForegroundActionResult = z.output<typeof cancelForegroundActionResultSchema>;
export type CancelForegroundActionOutput = ActionOutput<
  typeof CANCEL_FOREGROUND_ACTION,
  CancelForegroundActionResult
>;

export function parseCancelForegroundActionRequest(raw: unknown): CancelForegroundActionRequest {
  return cancelForegroundActionInputSchema.parse(raw ?? {});
}
