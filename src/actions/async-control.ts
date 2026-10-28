import { z } from "zod";

/** The wait and cancel tools' contracts, and the submission fields every task accepts. */
export const submissionMetadataSchema = z.object({
  submission_id: z.string().trim().min(1).max(200),
  wait_timeout_ms: z.number().int().min(0).max(120000).optional().describe("Optionally wait after admission until completion or this timeout. Returns the full result or pending progress. Omit for an immediate accepted handle; zero polls immediately. Timeout or caller cancellation never cancels admitted work."),
});
export type SubmissionMetadata = z.output<typeof submissionMetadataSchema>;
export const waitForActionInputSchema = z.strictObject({ action_id: z.string().min(1), timeout_ms: z.number().int().min(0).max(120000) });
export const cancelActionInputSchema = z.strictObject({ action_id: z.string().min(1), reason: z.string().trim().min(1).max(512) });
export const WAIT_FOR_ACTION_DESCRIPTION = "Wait for a specific action to settle or timeout_ms to elapse. Timeout leaves the action running. Zero reads immediately. Returning the full final output releases the result gate for the next foreground submission. Pending waits do not.";
export const CANCEL_ACTION_DESCRIPTION = "Request cancellation of the specified objective. Necessary survival work may continue until safe release. Wait for its final result before starting another action.";
