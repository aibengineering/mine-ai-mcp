import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ObserveRequest, RequestSnapshot } from "../session/request.js";
import { progressSchema, type Progress } from "../session/progress.js";
import { requestSchema, survivalStatusSchema, type SurvivalStatus } from "../survival/evidence/contract.js";
import { policySnapshotSchema, type PolicySnapshot } from "../survival/policy/contract.js";
import type { Facts } from "../survival/state/answered.js";

export type ActionResult =
  { status: "succeeded" } | { status: "partial" | "failed" | "cancelled"; error: string };

/** Build an action-owned result schema around the evidence that action observes. */
export function actionResultSchema<const Evidence extends z.ZodRawShape>(evidence: Evidence) {
  return z.discriminatedUnion("status", [
    z.strictObject({ ...evidence, status: z.literal("succeeded") }),
    z.strictObject({ ...evidence, status: z.literal("partial"), error: z.string() }),
    z.strictObject({ ...evidence, status: z.literal("failed"), error: z.string() }),
    z.strictObject({ ...evidence, status: z.literal("cancelled"), error: z.string() }),
  ]);
}

/** The session can stop without obtaining action-owned evidence. */
export const runtimeFailureSchema = z.discriminatedUnion("status", [
  z.strictObject({ kind: z.literal("runtime_failure"), status: z.literal("failed"), error: z.string() }),
  z.strictObject({ kind: z.literal("runtime_failure"), status: z.literal("cancelled"), error: z.string() }),
]);

export type RuntimeFailure = z.output<typeof runtimeFailureSchema>;

/**
 * Layer 3 (Session Runtime Output): Runtime-owned execution envelope wrapping an action result.
 * Adds lifecycle metadata (action name, execution duration in ms) and handles pre-execution
 * runtime failures (such as busy session refusals, argument schema validation errors, or cancellation).
 */
export type ActionOutput<Name extends string, Result extends ActionResult> = {
  action: Name;
  durationMs: number;
  result: Result | RuntimeFailure;
  /**
   * Reasons for resumptions, in order. The action owns its request evidence;
   * duration spans the whole request, including reflex time.
   */
  interruptions?: readonly string[];
  survivalPolicy?: PolicySnapshot;
  survival?: SurvivalStatus;
  request?: RequestSnapshot;
  progress?: Progress;
};

export function actionOutputSchema<const Name extends string, Result extends ActionResult>(
  name: Name,
  resultSchema: z.ZodType<Result, Result>,
  progressRequestSchema: z.ZodType<RequestSnapshot, RequestSnapshot> = requestSchema,
): z.ZodType<ActionOutput<Name, Result>, ActionOutput<Name, Result>> {
  return z.strictObject({
    action: z.literal(name),
    durationMs: z.number().int().nonnegative(),
    result: z.union([resultSchema, runtimeFailureSchema]),
    interruptions: z.array(z.string().min(1)).min(1).optional(),
    survivalPolicy: policySnapshotSchema.optional(),
    survival: survivalStatusSchema.optional(),
    request: progressRequestSchema.optional(),
    progress: progressSchema.optional(),
  });
}

/**
 * Cancellation and action-owned progress observation. The runner combines its
 * owned foreground cancellation with the caller's signal. Highlighting reaches an action
 * through the ambient highlighter the action runner installs, so an action needs no
 * debugging vocabulary of its own.
 */
export interface ActionContext {
  readonly signal?: AbortSignal;
  readonly observeProgress?: ObserveRequest;
}

/** Whether an action observes, owns the foreground slot, or controls that slot from outside it. */
export type ActionExecution =
  | { readonly kind: "information" }
  | {
      readonly kind: "task";
      readonly prepare?: () => Promise<void> | void;
    }
  | { readonly kind: "resumable_task"; readonly prepare?: () => Promise<void> | void }
  | { readonly kind: "control" };

/** One thing the bot can be asked to run, from MCP schema through to execution. */
interface ActionContract<
  Name extends string = string,
  Request = unknown,
  Result extends ActionResult = ActionResult,
> {
  name: Name;
  description: string;
  /** The action's own object input schema, before MCP adds invocation metadata. */
  inputSchema: z.ZodObject;
  /** The action-owned settled result, before runtime measurement or refusal. */
  resultSchema: z.ZodType<Result, Result>;
  /** Domain checkpoint contract, shared by pending and final progress. */
  checkpointSchema?: z.ZodType<Facts, Facts>;
  progressRequestSchema: z.ZodType<RequestSnapshot, RequestSnapshot>;
  /** Generated from the action result plus the runtime-owned envelope. */
  outputSchema: z.ZodType<ActionOutput<Name, Result>, ActionOutput<Name, Result>>;
  /** Present the action-owned evidence as useful Markdown. */
  formatResult(result: Result): string;
  annotations?: ToolAnnotations;
  /** Reject bad arguments before execution starts. */
  parse(input: unknown): Request;
}

export type RequestExecution<Result extends ActionResult> = (context: ActionContext) => Promise<Result>;

export type OneShotAction<
  Name extends string = string,
  Request = unknown,
  Result extends ActionResult = ActionResult,
> = ActionContract<Name, Request, Result> & {
  execution: Exclude<ActionExecution, { kind: "resumable_task" }>;
  execute(request: Request, context: ActionContext): Promise<Result>;
  begin?: never;
};

export type ResumableAction<
  Name extends string = string,
  Request = unknown,
  Result extends ActionResult = ActionResult,
> = ActionContract<Name, Request, Result> & {
  execution: Extract<ActionExecution, { kind: "resumable_task" }>;
  /** Created once after admission. Lifetime ends with the logical request; each physical attempt gets its own signal. */
  begin(request: Request, lifetime: AbortSignal, observe: ObserveRequest): RequestExecution<Result>;
  execute?: never;
};

export type Action<
  Name extends string = string,
  Request = unknown,
  Result extends ActionResult = ActionResult,
> = OneShotAction<Name, Request, Result> | ResumableAction<Name, Request, Result>;

type Definition<Action> = Omit<Action, "outputSchema" | "progressRequestSchema" | "annotations"> & {
  /** `readOnlyHint` is derived from execution so the runtime and MCP contract cannot disagree. */
  readonly annotations?: Omit<ToolAnnotations, "readOnlyHint">;
};

export type ActionDefinition<Name extends string, Request, Result extends ActionResult> =
  Definition<OneShotAction<Name, Request, Result>> | Definition<ResumableAction<Name, Request, Result>>;

/** Bind an executor to its schemas and generate the runtime output contract. */
export function defineAction<const Name extends string, Request, Result extends ActionResult>(
  definition: Definition<OneShotAction<Name, Request, Result>>,
): OneShotAction<Name, Request, Result>;
export function defineAction<const Name extends string, Request, Result extends ActionResult>(
  definition: Definition<ResumableAction<Name, Request, Result>>,
): ResumableAction<Name, Request, Result>;
export function defineAction<const Name extends string, Request, Result extends ActionResult>(
  definition: ActionDefinition<Name, Request, Result>,
): Action<Name, Request, Result>;
export function defineAction<const Name extends string, Request, Result extends ActionResult>(
  definition: ActionDefinition<Name, Request, Result>,
): Action<Name, Request, Result> {
  const progressRequestSchema = definition.checkpointSchema ? requestSchema.extend({
    action: z.literal(definition.name),
    evidence: requestSchema.shape.evidence.unwrap().extend({
      checkpoint: z.union([z.strictObject({ phase: z.literal("executing") }), definition.checkpointSchema]),
    }).nullable(),
  }) : requestSchema;
  const outputSchema = actionOutputSchema(definition.name, definition.resultSchema, progressRequestSchema);
  return {
    ...definition,
    annotations: {
      ...definition.annotations,
      readOnlyHint: definition.execution.kind === "information",
    },
    outputSchema,
    progressRequestSchema,
  };
}
