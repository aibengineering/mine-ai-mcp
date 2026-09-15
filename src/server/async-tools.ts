import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Action, ActionOutput, ActionResult } from "../actions/action.js";
import type { ActionRequestInput, ActionResponseInput, ActionCallStatus } from "../bot-data/action-call-log.js";
import { notificationSummarySchema, type NotificationSummary } from "../bot-data/event-log.js";
import { acceptanceSchema, refusalSchema, submissionMetadataSchema, type AsyncActions } from "../session/async-actions.js";
import { waitForActionInputSchema, cancelActionInputSchema, WAIT_FOR_ACTION_DESCRIPTION, CANCEL_ACTION_DESCRIPTION } from "../session/async-actions.js";
import { combatResourcesSchema, progressSchema, reflexActivitySchema } from "../session/progress.js";
import { requestSchema } from "../survival/evidence/contract.js";
import { formatNotifications } from "./notifications.js";
import { survivalStatusSchema, type SurvivalStatus } from "../survival/evidence/contract.js";
import { formatPolicyReminder, formatProtocol } from "./async-format.js";
import { toolChangeSchema } from "../world/tool-tiers.js";

export const liveProgressSchema = z.strictObject({
  actionId: z.string(), action: z.string(), progress: progressSchema, request: requestSchema.nullable(),
});
export const foregroundStatusSchema = z.strictObject({
  active: liveProgressSchema.nullable(),
  awaitingResult: z.strictObject({ actionId: z.string(), action: z.string() }).nullable(),
  storageError: z.string().nullable(),
});
const metaSchema = z.object({
  rationale: z.string().trim().min(1).max(200),
  response_format: z.enum(["markdown", "json"]).default("markdown"),
});
interface Runtime {
  actions: readonly Action[];
  asyncActions: AsyncActions;
  notificationSummary(): NotificationSummary;
  survivalStatus?(): SurvivalStatus | undefined;
  recordActionRequest(input: ActionRequestInput): number;
  recordActionResponse(input: ActionResponseInput): void;
}
type Output = ActionOutput<string, ActionResult>;
type Render = (action: Action, output: Output) => string;

export function isForeground(action: Action): boolean {
  return action.execution.kind === "task" || action.execution.kind === "resumable_task";
}

/** Protocol tools delegate execution lifetime to the bot-owned service. */
export function registerAsyncTools(server: McpServer, runtime: Runtime, render: Render): void {
  const foreground = runtime.actions.filter(isForeground);
  if (foreground.length === 0) return;
  function progressFor(action: Action) {
    return liveProgressSchema.extend({ action: z.literal(action.name), request: action.progressRequestSchema.nullable() });
  }
  function waitSchema(output: z.ZodType, progress: z.ZodType) {
    return z.union([
      refusalSchema,
      z.strictObject({ state: z.literal("pending"), wakeReason: z.literal("timeout"), actionId: z.string(),
        progress,
        survival: survivalStatusSchema.optional(),
        vitalsDuringWait: z.strictObject({ healthBefore: z.number(), healthAfter: z.number(), foodBefore: z.number(), foodAfter: z.number() }).optional(),
        duringWait: z.strictObject({ from: z.string(), to: z.string(), elapsedMs: z.number(), suspendedMs: z.number(),
          distanceTravelledBlocks: z.number(), reflexDistanceBlocks: z.number(), combatResources: combatResourcesSchema,
          reflexActivity: reflexActivitySchema,
          checkpointDelta: z.record(z.string(), z.number()), toolChanges: z.array(toolChangeSchema) }),
      }),
      z.strictObject({ state: z.literal("settled"), wakeReason: z.literal("settled"), actionId: z.string(), output,
        survival: survivalStatusSchema.optional() }),
      z.strictObject({ state: z.literal("storage_failed"), actionId: z.string(), error: z.string(), output }),
    ]);
  }

  // Initial and subsequent waits share observation, timeout, and retrieval behavior.
  async function wait(actionId: string, timeoutMs: number, signal: AbortSignal) {
    const before = runtime.survivalStatus?.()?.vitals;
    const outcome = await runtime.asyncActions.wait(actionId, timeoutMs, signal);
    // A settled result carries the policy in force at retrieval, so the Markdown reminder can sit beside its reflex counts.
    if (outcome.state === "settled" && outcome.wakeReason === "settled") {
      const survival = runtime.survivalStatus?.();
      return survival ? { ...outcome, survival } : outcome;
    }
    if (outcome.state !== "pending") return outcome;
    const survival = runtime.survivalStatus?.();
    return { ...outcome, ...(survival ? { survival } : {}),
      ...(before && survival ? { vitalsDuringWait: {
        healthBefore: before.health, healthAfter: survival.vitals.health,
        foodBefore: before.food, foodAfter: survival.vitals.food,
      } } : {}),
    };
  }

  function register(name: string, description: string, input: z.ZodObject, output: z.ZodType,
    invoke: (args: Record<string, unknown>, requestId: number, signal: AbortSignal, rationale: string) => unknown | Promise<unknown>, readOnly: boolean, annotations?: ToolAnnotations) {
    server.registerTool(name, {
      description, inputSchema: input.safeExtend(metaSchema.shape),
      outputSchema: z.strictObject({
        response: z.discriminatedUnion("format", [
          z.strictObject({ format: z.literal("markdown"), markdown: z.string() }),
          z.strictObject({ format: z.literal("json"), data: output }),
        ]), notifications: notificationSummarySchema.optional(),
      }),
      annotations: { ...(annotations ?? { destructiveHint: !readOnly, openWorldHint: true }), readOnlyHint: readOnly },
    }, async (args, extra) => {
      const { rationale, response_format } = metaSchema.parse(args);
      const { rationale: _rationale, response_format: _format, ...input } = args;
      const started = performance.now();
      const requestId = runtime.recordActionRequest({ actionName: name, rationale, requestedAt: new Date().toISOString(), request: args });
      const data = output.parse(await invoke(input, requestId, extra.signal, rationale)) as Record<string, unknown>;
      const result = data.output as Output | undefined;
      const isError = data.state === "refused" || data.state === "storage_failed" || result?.result.status === "failed" || result?.result.status === "cancelled";
      const notifications = runtime.notificationSummary();
      const action = result ? runtime.actions.find((entry) => entry.name === result.action) : undefined;
      const policyReminder = result?.progress ? formatPolicyReminder(data.survival as SurvivalStatus | undefined, result.progress.reflexActivity) : null;
      const markdown = result && action
        ? `Action ID: ${data.actionId}\n${data.error ? `Storage error: ${data.error}\n` : ""}\n${render(action, result)}${policyReminder ? `\n\n${policyReminder}` : ""}`
        : formatProtocol(data as Parameters<typeof formatProtocol>[0]);
      const notificationNotice = formatNotifications(notifications);
      const notice = notificationNotice ? `\n\n${notificationNotice}` : "";
      const reply = response_format === "json"
        ? { content: isError ? [{ type: "text" as const, text: String(data.error ?? (result && "error" in result.result ? result.result.error : "Action failed")) }] : [],
          structuredContent: { response: { format: "json" as const, data }, notifications }, isError }
        : { content: [{ type: "text" as const, text: markdown + notice }],
          structuredContent: { response: { format: "markdown" as const, markdown: markdown + notice } }, isError };
      try {
        runtime.recordActionResponse({ requestId, respondedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
          status: (result?.result.status ?? (data.state === "settled" ? "succeeded" : data.state)) as ActionCallStatus,
          response: { ...reply, execution: data },
        });
      } catch (error) {
        process.stderr.write(`[mine-ai-mcp] Call ${requestId} log failed after response: ${String(error)}\n`);
      }
      return reply;
    });
  }

  for (const action of foreground) register(action.name,
    `${action.description} Submits foreground work asynchronously. Supply a unique submission_id; set wait_timeout_ms to return a final result or pending progress in this call, or omit it for an immediate handle. Continue with wait_for_action when needed.`,
    action.inputSchema.safeExtend(submissionMetadataSchema.shape), z.union([acceptanceSchema, waitSchema(action.outputSchema, progressFor(action))]),
    async (args, requestId, signal, rationale) => {
      const metadata = submissionMetadataSchema.parse(args);
      const { submission_id: _id, wait_timeout_ms, ...input } = args;
      const submitted = runtime.asyncActions.submit(action, input, metadata, requestId, rationale);
      if (submitted.state !== "accepted" || wait_timeout_ms === undefined) return submitted;
      return wait(submitted.actionId, Number(wait_timeout_ms), signal);
    }, false, action.annotations);

  register("wait_for_action", WAIT_FOR_ACTION_DESCRIPTION,
    waitForActionInputSchema, waitSchema(z.union(foreground.map((action) => action.outputSchema)), z.union(foreground.map(progressFor))),
    (args, _id, signal) => wait(String(args.action_id), Number(args.timeout_ms), signal), true);

  register("cancel_foreground_action", CANCEL_ACTION_DESCRIPTION,
    cancelActionInputSchema,
    z.union([refusalSchema,
      z.strictObject({ state: z.literal("settled"), actionId: z.string() }),
      z.strictObject({ state: z.literal("cancellation_requested"), actionId: z.string(), cancellation: z.union([
        z.strictObject({ kind: z.literal("idle"), reason: z.string() }),
        z.strictObject({ kind: z.literal("cancellation_requested"), action: z.string(), startedAt: z.string(), reason: z.string() }),
      ]) }),
    ]), (args) => runtime.asyncActions.cancel(String(args.action_id), String(args.reason)), false);
}
