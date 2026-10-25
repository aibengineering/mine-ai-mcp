/**
 * The MCP reply envelope, shared by the action tools (mcp.ts) and the
 * asynchronous foreground tools (async-tools.ts). Both once built it by hand,
 * and the two copies had already drifted in their call-log failure line.
 */
import { z } from "zod";
import type { ActionResponseInput } from "../bot-data/action-call-log.js";
import { notificationSummarySchema, type NotificationSummary } from "../bot-data/event-log.js";
import { formatNotifications } from "./notifications.js";

const rationaleSchema = z.string().trim().min(1).max(200);
const responseFormatSchema = z.enum(["markdown", "json"]).default("markdown");
export type ResponseFormat = z.output<typeof responseFormatSchema>;

/** The metadata every tool call carries, described as the action tools publish it. */
export const requestMetaSchema = z.object({
  rationale: rationaleSchema.describe(
    "One sentence explaining why this action advances the current goal, based on observed facts.",
  ),
  response_format: responseFormatSchema.describe(
    "Response representation. Defaults to markdown; use json for structuredContent without duplicate text.",
  ),
});

/**
 * The same metadata without descriptions, which is how the asynchronous
 * tools have always published it. Kept apart only so their published input
 * schemas do not change; the rules are the ones above.
 */
export const undescribedRequestMetaSchema = z.object({
  rationale: rationaleSchema,
  response_format: responseFormatSchema,
});

/** The structured output schema of a tool whose JSON reply carries `data`. */
export function replyOutputSchema(data: z.ZodType, extra: z.ZodRawShape = {}) {
  return z.strictObject({
    response: z.discriminatedUnion("format", [
      z.strictObject({ format: z.literal("markdown"), markdown: z.string() }),
      z.strictObject({ format: z.literal("json"), data }),
    ]),
    // The SDK accepts only object-root output schemas. This field is present in
    // JSON mode and omitted when the same summary is rendered into Markdown.
    notifications: notificationSummarySchema.optional(),
    ...extra,
  });
}

export type McpReply<Data> =
  | {
      content: [{ type: "text"; text: string }];
      // The same text again: a client that renders structuredContent whenever it
      // is present showed an empty envelope for every markdown call.
      structuredContent: { response: { format: "markdown"; markdown: string } };
      isError: boolean;
    }
  | {
      // Empty when the call succeeded, so JSON callers are not sent the same
      // evidence twice; a failure still puts its reason here, because that is
      // where an MCP client reads an error from.
      content: [] | [{ type: "text"; text: string }];
      structuredContent: { response: { format: "json"; data: Data }; notifications: NotificationSummary };
      isError: boolean;
    };

/**
 * Build one reply. `data`, `markdown` and `failure` are produced only for the
 * format that shows them; unread notifications close a Markdown reply.
 */
export function mcpReply<Data>(
  format: ResponseFormat,
  reply: {
    readonly data: () => Data;
    readonly isError: boolean;
    readonly markdown: () => string;
    readonly failure: () => string;
    readonly notifications: NotificationSummary;
  },
): McpReply<Data> {
  const { isError, notifications } = reply;
  if (format === "json") {
    return {
      content: isError ? [{ type: "text", text: reply.failure() }] : [],
      structuredContent: { response: { format: "json", data: reply.data() }, notifications },
      isError,
    };
  }
  const notice = formatNotifications(notifications);
  const markdown = notice ? `${reply.markdown()}\n\n${notice}` : reply.markdown();
  return {
    content: [{ type: "text", text: markdown }],
    structuredContent: { response: { format: "markdown", markdown } },
    isError,
  };
}

/**
 * Record the reply a client was sent. Persistence is auxiliary evidence:
 * never replace an observed result with a retryable MCP failure after the
 * call has already run, so a recording failure goes to the operator only.
 */
export function recordReply(
  log: { recordActionResponse(response: ActionResponseInput): void },
  response: ActionResponseInput,
  toolName: string,
): void {
  try {
    log.recordActionResponse(response);
  } catch (cause) {
    const error = cause instanceof Error ? cause.stack || cause.message : String(cause);
    process.stderr.write(
      `[mine-ai-mcp] Could not record response for request ${response.requestId} (${toolName}): ${error}\n`,
    );
  }
}
