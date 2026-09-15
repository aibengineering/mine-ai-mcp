/**
 * The MCP protocol boundary, and nothing else. It publishes whatever actions
 * the list holds, hands their arguments to the action runner, and records each
 * accepted request with the response produced for its caller. It knows nothing
 * about Minecraft.
 *
 * Built on `McpServer` rather than the low-level `Server`, which the SDK
 * deprecates for everything except advanced protocol work.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEBUG_EXECUTE_JAVASCRIPT } from "../actions/debug-execute-javascript/contract.js";
import type { Action, ActionOutput, ActionResult, RuntimeFailure } from "../actions/index.js";
import { VIEW_STATUS } from "../actions/view-status/contract.js";
import type { ActionRequestInput, ActionResponseInput } from "../bot-data/action-call-log.js";
import { notificationSummarySchema, type NotificationSummary } from "../bot-data/event-log.js";
import type { ActionRunner } from "../session/action-runner.js";
import { formatNotifications } from "./notifications.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import { formatSurvivalStatus } from "../survival/evidence/format.js";
import type { AsyncActions } from "../session/async-actions.js";
import { foregroundStatusSchema, isForeground, registerAsyncTools } from "./async-tools.js";
import { formatFinalProgress, formatForegroundStatus } from "./async-format.js";

const rationaleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("One sentence explaining why this action advances the current goal, based on observed facts.");

const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Response representation. Defaults to markdown; use json for structuredContent without duplicate text.");

type ResponseFormat = "markdown" | "json";

type McpResponse<Name extends string, Result extends ActionResult> =
  | {
      content: [{ type: "text"; text: string }];
      // The same text again: a client that renders structuredContent whenever it
      // is present showed an empty envelope for every markdown call.
      structuredContent: { response: { format: "markdown"; markdown: string } };
      isError: boolean;
    }
  | {
      // Empty when the action settled, so JSON callers are not sent the same
      // evidence twice; a failure still puts its reason here, because that is
      // where an MCP client reads an error from.
      content: [] | [{ type: "text"; text: string }];
      structuredContent: {
        response: { format: "json"; data: ActionOutput<Name, Result> };
        notifications: NotificationSummary;
      };
      isError: boolean;
    };

function parseResponseFormat(value: unknown): ResponseFormat {
  return responseFormatSchema.parse(value);
}

interface ActionRuntime {
  status?(): { survival: SurvivalStatus };
  readonly asyncActions?: AsyncActions;
  readonly actions: readonly Action[];
  readonly run: ActionRunner["run"];
  readonly notificationSummary: () => NotificationSummary;
  readonly recordActionRequest: (request: ActionRequestInput) => number;
  readonly recordActionResponse: (response: ActionResponseInput) => void;
}

function isRuntimeFailure(result: ActionResult | RuntimeFailure): result is RuntimeFailure {
  return "kind" in result && result.kind === "runtime_failure";
}

function mcpOutputSchema<Name extends string, Result extends ActionResult>(
  action: Action<Name, unknown, Result>,
) {
  return z.strictObject({
    response: z.discriminatedUnion("format", [
      z.strictObject({ format: z.literal("markdown"), markdown: z.string() }),
      z.strictObject({
        format: z.literal("json"),
        data: action.outputSchema,
      }),
    ]),
    // The SDK accepts only object-root output schemas. This field is present in
    // JSON mode and omitted when the same summary is rendered into Markdown.
    notifications: notificationSummarySchema.optional(),
    ...(action.name === VIEW_STATUS ? { foreground: foregroundStatusSchema.optional() } : {}),
  });
}

/**
 * Why a stopped action stopped, in one line.
 *
 * Every failed or cancelled result carries an `error`, whether it came from the
 * action or from the runtime, so there is always something to say. Kept to a
 * line: the JSON caller is reading the full evidence from `structuredContent`,
 * and only needs `content` to say what went wrong.
 */
function failureText<Name extends string, Result extends ActionResult>(
  output: ActionOutput<Name, Result>,
): string {
  const result = output.result;
  const reason = "error" in result ? result.error : "no reason reported";
  return `${output.action} ${result.status}: ${reason}`;
}

function response<Name extends string, Result extends ActionResult>(
  action: Action<Name, unknown, Result>,
  output: ActionOutput<Name, Result>,
  format: ResponseFormat,
  notifications: NotificationSummary,
): McpResponse<Name, Result> {
  const result = output.result;
  // A partial result kept some ground; only a total stop is reported as an error.
  const isError = result.status === "failed" || result.status === "cancelled";
  if (format === "json") {
    return {
      content: isError ? [{ type: "text", text: failureText(output) }] : [],
      structuredContent: {
        response: { format: "json", data: action.outputSchema.parse(output) },
        notifications,
      },
      isError,
    };
  }

  const body = isRuntimeFailure(result) ? `**Runtime failure:** ${result.error}` : action.formatResult(result);
  const sections = [
    `## \`${output.action}\``,
    `**Status:** ${result.status}  `,
    `**Duration:** ${output.durationMs} ms`,
    ...(output.interruptions
      ? [`**Interruptions:** ${output.interruptions.map((reason) => `\`${reason}\``).join(", ")}`]
      : []),
    body,
    ...(output.progress ? [formatFinalProgress(output.progress, output.request)] : []),
    ...(output.survival ? [formatSurvivalStatus(output.survival)] : []),
    ...(!output.survival && output.survivalPolicy?.constraint
      ? [`**Survival limitation:** ${output.survivalPolicy.constraint}`]
      : []),
  ];
  const notificationNotice = formatNotifications(notifications);
  if (notificationNotice) sections.push(notificationNotice);
  const markdown = sections.join("\n\n");
  return {
    content: [{ type: "text", text: markdown }],
    structuredContent: { response: { format: "markdown", markdown } },
    isError,
  };
}


function serverInstructions(runtime: ActionRuntime, username: string): string {
  const instructions = [
    `This server controls and inspects Minecraft bot ${username} through Minecraft actions.`,
    "Prefer the default Markdown response format for regular usage.",
    `Read live vitals, the clock, position, inventory, and nearby entities with ${VIEW_STATUS}.`,
  ];
  if (runtime.asyncActions) instructions.push("Foreground tools accept optional wait_timeout_ms (0..120000): return a full settled result or pending progress in the initial call; omit it for an immediate accepted action ID. Prefer an initial bounded wait for ordinary work. Supply a unique submission_id and reuse it only to retry the same submission. Call wait_for_action with a bounded timeout to inspect progress or get the full result; timeout never cancels execution. Information and control tools remain available. Before the next foreground action, retrieve the preceding full result with wait_for_action. A settled wait releases that gate automatically; pending waits and status reads do not. Cancellation requires action_id and must be followed by result retrieval.");
  if (runtime.actions.some((action) => action.name === DEBUG_EXECUTE_JAVASCRIPT)) {
    instructions.push(
      `Use ${DEBUG_EXECUTE_JAVASCRIPT} only when the standard actions cannot accomplish the task, and explain in its rationale why debug access is required.`,
    );
  }
  return instructions.join(" ");
}

/** Create one disposable MCP protocol session over the process-owned bot session. */
export function createMinecraftMcpServer(runtime: ActionRuntime, username: string): McpServer {
  // No `capabilities` here: registerTool declares the tools capability itself,
  // and declaring it by hand only restates what the first registration does.
  const server = new McpServer(
    { name: "mine-ai-mcp", version: "0.1.0" },
    {
      instructions: serverInstructions(runtime, username),
    },
  );

  for (const action of runtime.actions) {
    if (runtime.asyncActions && (isForeground(action) || action.name === "cancel_foreground_action")) continue;
    const inputSchema = action.inputSchema.safeExtend({
      rationale: rationaleSchema,
      response_format: responseFormatSchema,
    });
    const structuredOutputSchema = mcpOutputSchema(action);
    server.registerTool(
      action.name,
      {
        description: action.description,
        inputSchema,
        outputSchema: structuredOutputSchema,
        annotations: action.annotations,
      },
      async ({ rationale, response_format, ...input }, extra) => {
        const requestedAt = new Date().toISOString();
        const acceptedRationale = rationaleSchema.parse(rationale);
        const format = parseResponseFormat(response_format);
        // Persist before admission so another connection can observe the action
        // as pending for its entire execution.
        const requestId = runtime.recordActionRequest({
          actionName: action.name,
          rationale: acceptedRationale,
          requestedAt,
          request: { ...input, rationale: acceptedRationale, response_format: format },
        });
        const output = await runtime.run(action, input, extra.signal, requestId);
        const rendered = response(action, output, format, runtime.notificationSummary());
        const foreground = action.name === VIEW_STATUS ? runtime.asyncActions?.status() : undefined;
        const reply = (() => {
          if (!foreground) return rendered;
          if (format === "markdown") {
            const markdown = `${"markdown" in rendered.structuredContent.response ? rendered.structuredContent.response.markdown : ""}\n\n${formatForegroundStatus(foreground)}`;
            return { ...rendered, content: [{ type: "text" as const, text: markdown }], structuredContent: { response: { format: "markdown" as const, markdown } } };
          }
          return { ...rendered, structuredContent: { ...rendered.structuredContent, foreground } };
        })();
        try {
          runtime.recordActionResponse({
            requestId,
            respondedAt: new Date().toISOString(),
            durationMs: output.durationMs,
            status: output.result.status,
            // The reply the client saw, plus the action's own structured result,
            // which a markdown reply carries only as prose: the call log is
            // read afterwards by people and scripts asking what actually happened.
            response: { ...reply, result: output.result, interruptions: output.interruptions ?? [] },
          });
        } catch (cause) {
          // Persistence is auxiliary evidence. Never replace an observed action
          // result with a retryable MCP failure after the action has already run.
          const error = cause instanceof Error ? cause.stack || cause.message : String(cause);
          process.stderr.write(
            `[mine-ai-mcp] Could not record response for request ${requestId} (${action.name}): ${error}\n`,
          );
        }
        return reply;
      },
    );
  }

  if (runtime.asyncActions) registerAsyncTools(server, { ...runtime, asyncActions: runtime.asyncActions,
    survivalStatus: () => runtime.status?.().survival,
    notificationSummary: () => runtime.notificationSummary(), recordActionRequest: (input) => runtime.recordActionRequest(input),
    recordActionResponse: (input) => runtime.recordActionResponse(input),
  }, (action, output) => {
    const reply = response(action, output, "markdown", { unreadCount: 0 });
    return "markdown" in reply.structuredContent.response ? reply.structuredContent.response.markdown : "";
  });

  return server;
}
