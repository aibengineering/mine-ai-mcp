import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { botEventSchema } from "../../bot-data/index.js";
import type { ActionOutput } from "../action.js";
import { sqlActionResultSchema } from "../sql-action.js";

export const READ_RECENT_EVENTS = "read_recent_events" as const;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 100;
export const READ_RECENT_EVENTS_DESCRIPTION =
  "Read the bot's oldest unread events in full and advance its event cursor through the returned page. Includes runtime lifecycle events and incoming and outgoing chat; notifications are a separate MCP response policy.";

export const readRecentEventsInputSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVENT_LIMIT)
    .default(DEFAULT_EVENT_LIMIT)
    .describe("Maximum oldest unread events to return and mark read. Defaults to 50; maximum 100."),
});

export type ReadRecentEventsRequest = z.output<typeof readRecentEventsInputSchema>;

export const readRecentEventsResultSchema = sqlActionResultSchema({
  events: z.array(botEventSchema).max(MAX_EVENT_LIMIT),
  readThroughEventId: z.number().int().nonnegative(),
  remainingEventCount: z.number().int().nonnegative(),
});

export type ReadRecentEventsResult = z.output<typeof readRecentEventsResultSchema>;
export type ReadRecentEventsOutput = ActionOutput<
  typeof READ_RECENT_EVENTS,
  ReadRecentEventsResult
>;

export const readRecentEventsAnnotations = {
  destructiveHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

export function parseReadRecentEventsRequest(input: unknown): ReadRecentEventsRequest {
  return readRecentEventsInputSchema.parse(input ?? {});
}
