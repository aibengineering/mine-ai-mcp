import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Action, ActionOutput } from "../actions/action.js";
import type { SqlBotData } from "../bot-data/sql-bot-data.js";
import type { ActionRunner } from "./action-runner.js";
import { progressChange, type Progress } from "./progress.js";
import type { RequestSnapshot } from "./request.js";

export const submissionMetadataSchema = z.object({
  submission_id: z.string().trim().min(1).max(200),
  wait_timeout_ms: z.number().int().min(0).max(120000).optional().describe("Optionally wait after admission until completion or this timeout. Returns the full result or pending progress. Omit for an immediate accepted handle; zero polls immediately. Timeout or caller cancellation never cancels admitted work."),
});
export type SubmissionMetadata = z.output<typeof submissionMetadataSchema>;
export const waitForActionInputSchema = z.strictObject({ action_id: z.string().min(1), timeout_ms: z.number().int().min(0).max(120000) });
export const cancelActionInputSchema = z.strictObject({ action_id: z.string().min(1), reason: z.string().trim().min(1).max(512) });
export const WAIT_FOR_ACTION_DESCRIPTION = "Wait for a specific action to settle or timeout_ms to elapse. Timeout leaves the action running. Zero reads immediately. Returning the full final output releases the result gate for the next foreground submission. Pending waits do not.";
export const CANCEL_ACTION_DESCRIPTION = "Request cancellation of the specified objective. Necessary survival work may continue until safe release. Wait for its final result before starting another action.";
export const refusalSchema = z.strictObject({
  state: z.literal("refused"), code: z.string(), error: z.string(),
  activeActionId: z.string().optional(), unretrievedActionId: z.string().optional(),
});
export const acceptanceSchema = z.strictObject({
  state: z.literal("accepted"), actionId: z.string(), action: z.string(), admittedAt: z.string(),
});
export type Refusal = z.output<typeof refusalSchema>;
export type Acceptance = z.output<typeof acceptanceSchema>;
export type LiveProgress = { actionId: string; action: string; progress: Progress; request: RequestSnapshot | null };
export type WaitOutcome = Refusal | {
  state: "pending"; wakeReason: "timeout"; actionId: string;
  progress: LiveProgress; duringWait: ReturnType<typeof progressChange>;
} | {
  state: "settled"; wakeReason: "settled"; actionId: string; output: ActionOutput<string, import("../actions/action.js").ActionResult>;
} | { state: "storage_failed"; actionId: string; error: string; output: ActionOutput<string, import("../actions/action.js").ActionResult> };

type Output = ActionOutput<string, import("../actions/action.js").ActionResult>;
interface RecordData {
  actionId: string;
  submissionId: string;
  action: string;
  arguments: unknown;
  admittedAt: string;
  requestId: number;
  rationale: string | null;
  resultRetrieved: boolean;
  checkpoint: LiveProgress | null;
  terminal: { output: Output } | null;
}
interface Execution {
  record: RecordData;
  settled: Promise<void>;
  settle(): void;
  persistenceError: string | null;
  listeners: Set<() => void>;
  dirty: boolean;
}

function execution(record: RecordData): Execution {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  if (record.terminal) settle();
  return { record, settled, settle, persistenceError: null, listeners: new Set(), dirty: false };
}
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function refused(code: string, error: string): Refusal { return { state: "refused", code, error }; }

/** Durable execution rows are separate from the log of individual MCP calls. */
export class ExecutionStore {
  constructor(private readonly data: SqlBotData, private readonly botId: string) {}
  load(): RecordData[] {
    return this.data.read("SELECT record_json FROM action_executions WHERE bot_id = ? ORDER BY rowid", this.botId)
      .map((row) => {
        // Earlier development records used a caller acknowledgement and receipt.
        const { acknowledged, terminal, ...record } = JSON.parse(String(row.record_json));
        return { ...record, resultRetrieved: record.resultRetrieved ?? acknowledged ?? false,
          terminal: terminal ? { output: terminal.output } : null } as RecordData;
      });
  }
  write(records: readonly RecordData[]): void {
    this.data.transaction((db) => {
      const put = db.prepare(`INSERT INTO action_executions VALUES (?, ?, ?, ?)
        ON CONFLICT(bot_id, action_id) DO UPDATE SET record_json = excluded.record_json`);
      for (const record of records) put.run(this.botId, record.actionId, record.submissionId, JSON.stringify(record));
    }, { name: "persist-action-execution" });
  }
}

/** One logical execution service per bot, shared by disposable MCP connections. */
export class AsyncActions {
  readonly #records = new Map<string, Execution>();
  readonly #submissions = new Map<string, Execution>();
  #active: Execution | null = null;
  #checkpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly runner: ActionRunner,
    private readonly run: ActionRunner["run"],
    private readonly store?: Pick<ExecutionStore, "load" | "write">,
  ) {
    for (const record of store?.load() ?? []) {
      if (!record.terminal) {
        const last = record.checkpoint?.progress;
        record.terminal = {
          output: {
            action: record.action, durationMs: last?.elapsedMs ?? 0,
            result: { kind: "runtime_failure", status: "failed", error: "[RUNTIME_INTERRUPTED] Previous runtime ended before recording settlement. World effects are unknown; execution was not replayed." },
            ...(last ? { progress: { ...last, state: "settled",
              positionAgeMs: last.positionSampledAt ? Math.max(0, Date.now() - Date.parse(last.positionSampledAt)) : null,
              movementCoverage: { complete: false, discontinuities: [...last.movementCoverage.discontinuities, "runtime_interrupted"] } } } : {}),
          },
        };
        store?.write([record]);
      }
      const retained = execution(record);
      this.#records.set(record.actionId, retained);
      this.#submissions.set(record.submissionId, retained);
    }
  }

  submit(action: Action, input: unknown, metadata: SubmissionMetadata, requestId: number, rationale: string | null = null): Acceptance | Refusal {
    let parsed: unknown;
    try { parsed = action.parse(input); }
    catch (error) { return refused("INVALID_ARGUMENTS", reason(error)); }
    const previous = this.#submissions.get(metadata.submission_id);
    if (previous) {
      return previous.record.action === action.name && isDeepStrictEqual(previous.record.arguments, parsed)
        ? this.#acceptance(previous.record)
        : refused("SUBMISSION_CONFLICT", "This submission_id already identifies different action arguments.");
    }
    if (!this.runner.ownership().connected) return refused("RUNTIME_UNAVAILABLE", "The bot connection has ended.");
    if (this.#active || this.runner.status().busy) return {
      ...refused("ACTION_BUSY", `No new action started; body owner: ${this.runner.ownership().current ?? "request settling"}. ${this.#active ? "Call wait_for_action with activeActionId to retrieve its result." : "Wait for physical ownership to become available."}`),
      ...(this.#active ? { activeActionId: this.#active.record.actionId } : {}),
    };
    const owed = [...this.#records.values()].find((item) => !item.record.resultRetrieved);
    if (owed) return {
      ...refused("RESULT_NOT_RETRIEVED", "No new action started. Call wait_for_action with unretrievedActionId to retrieve the preceding full result."),
      unretrievedActionId: owed.record.actionId,
    };
    const record: RecordData = {
      actionId: randomUUID(), submissionId: metadata.submission_id, action: action.name,
      arguments: structuredClone(parsed), admittedAt: new Date().toISOString(), requestId, rationale,
      resultRetrieved: false, checkpoint: null, terminal: null,
    };
    try { this.store?.write([record]); }
    catch (error) { return refused("ADMISSION_STORAGE_FAILED", reason(error)); }
    const admitted = execution(record);
    this.#records.set(record.actionId, admitted);
    this.#submissions.set(record.submissionId, admitted);
    this.#active = admitted;
    // Calling run synchronously reserves the physical runner before another admission can interleave.
    const outcome = this.run(action, input, undefined, requestId, record.actionId);
    record.checkpoint = this.#live(admitted);
    admitted.dirty = true;
    this.#persist(admitted);
    this.#checkpointTimer = setInterval(() => {
      record.checkpoint = this.#live(admitted);
      admitted.dirty = true;
      this.#persist(admitted);
    }, 5000);
    this.#checkpointTimer.unref();
    void outcome.then((output) => action.outputSchema.parse(output)).catch((error): Output => ({
      action: action.name, durationMs: this.runner.progress()?.elapsedMs ?? 0,
      result: { kind: "runtime_failure", status: "failed", error: `[EXECUTION_FAILED] ${reason(error)}` },
    })).then((output) => {
      if (this.#checkpointTimer) clearInterval(this.#checkpointTimer);
      this.#checkpointTimer = null;
      record.terminal = { output: structuredClone(output) };
      admitted.dirty = true;
      this.#persist(admitted);
      this.#active = null;
      admitted.settle();
      for (const listener of admitted.listeners) listener();
      admitted.listeners.clear();
    });
    return this.#acceptance(record);
  }

  async wait(actionId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) return refused("INVALID_ARGUMENTS", "timeout_ms must be an integer from 0 to 120000.");
    const retained = this.#records.get(actionId);
    if (!retained) return refused("ACTION_NOT_FOUND", "No execution with this action ID exists for this bot.");
    signal?.throwIfAborted();
    const before = this.#live(retained);
    if (!retained.record.terminal && timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); retained.listeners.delete(finish); };
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const timer = setTimeout(finish, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        retained.listeners.add(finish);
        if (retained.record.terminal) finish();
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    const terminal = retained.record.terminal;
    if (terminal) {
      if (!this.#persist(retained)) return { state: "storage_failed", actionId, error: retained.persistenceError!, output: structuredClone(terminal.output) };
      if (!retained.record.resultRetrieved) {
        try { this.store?.write([{ ...retained.record, resultRetrieved: true }]); }
        catch (error) {
          retained.persistenceError = reason(error);
          return { state: "storage_failed", actionId, error: retained.persistenceError, output: structuredClone(terminal.output) };
        }
        retained.record.resultRetrieved = true;
        retained.persistenceError = null;
      }
      return { state: "settled", wakeReason: "settled", actionId, output: structuredClone(terminal.output) };
    }
    const after = this.#live(retained);
    if (!before || !after) return refused("PROGRESS_UNAVAILABLE", "Execution is admitted but its initial progress snapshot is unavailable.");
    return {
      state: "pending", wakeReason: "timeout", actionId, progress: after,
      duringWait: progressChange(before.progress, after.progress, before.request?.evidence ?? null, after.request?.evidence ?? null),
    };
  }

  cancel(actionId: string, reason: string) {
    const retained = this.#records.get(actionId);
    if (!retained) return refused("ACTION_NOT_FOUND", "No execution with this action ID exists for this bot.");
    if (retained.record.terminal) return { state: "settled" as const, actionId };
    return { state: "cancellation_requested" as const, actionId, cancellation: this.runner.cancelRequest(actionId, reason) };
  }

  status() {
    const unread = [...this.#records.values()].find((item) => item.record.terminal && !item.record.resultRetrieved);
    return {
      active: this.#active ? this.#live(this.#active) : null,
      awaitingResult: unread ? { actionId: unread.record.actionId, action: unread.record.action } : null,
      storageError: this.#active?.persistenceError ?? unread?.persistenceError ?? null,
    };
  }

  async settled(): Promise<void> { await this.#active?.settled; }

  #acceptance(record: RecordData): Acceptance {
    return { state: "accepted", actionId: record.actionId, action: record.action, admittedAt: record.admittedAt };
  }
  #live(retained: Execution): LiveProgress | null {
    const progress = this.runner.progress();
    if (retained === this.#active && progress) return structuredClone({
      actionId: retained.record.actionId, action: retained.record.action, progress, request: this.runner.request(),
    });
    return retained.record.checkpoint ? structuredClone(retained.record.checkpoint) : null;
  }
  #persist(retained: Execution): boolean {
    if (!retained.dirty) return true;
    try { this.store?.write([retained.record]); retained.dirty = false; retained.persistenceError = null; return true; }
    catch (error) { retained.persistenceError = reason(error); return false; }
  }
}
