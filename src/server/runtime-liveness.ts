import { z } from "zod";
import { observeExecution, type ExecutionEvent } from "../execution/execution-scope.js";

// Four liveness observations per second; five seconds leaves 25 seconds before
// the observed Minecraft keepalive timeout. This never limits action duration.
export const RUNTIME_HEARTBEAT_MS = 250;
export const RUNTIME_UNRESPONSIVE_MS = 5_000;

const ownerSchema = z.object({
  bot: z.string(),
  operation: z.string(),
  targetId: z.number().nullable(),
  requestId: z.number().nullable().optional(),
  actionId: z.string().optional(),
});
const executionSchema = z.object({
  scopeId: z.string(),
  owner: ownerSchema,
  at: z.number(),
  sequence: z.number(),
  phase: z.string(),
  activePhase: z.string().nullable(),
  kind: z.enum(["entered", "returned", "closed", "yielded", "progress"]),
  reason: z.string().nullable().optional(),
  iterations: z.number().optional(),
  uninterruptedMs: z.number().optional(),
  firstYield: z.boolean().optional(),
});
const activitySchema = z.object({
  observedAt: z.number(),
  active: z.array(executionSchema),
  precedingRequestId: z.number().nullable(),
});
export type RuntimeActivity = z.infer<typeof activitySchema>;
export const runtimeMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), port: z.number().int().positive() }),
  z.object({
    kind: z.literal("heartbeat"),
    sequence: z.number().int(),
    executionEvents: z.number().int(),
    omitted: z.number().int(),
    memory: z.object({ rss: z.number(), heapUsed: z.number(), heapTotal: z.number(), external: z.number() }),
    activity: activitySchema,
  }),
  z.object({
    kind: z.literal("execution"),
    event: executionSchema,
    activity: activitySchema,
  }),
]);

/**
 * The heartbeat is sent only by a timer, never from an execution checkpoint.
 * IPC has at most one write in flight and one latest transition waiting: a
 * stopped supervisor cannot make execution telemetry allocate without bound.
 * Omitted transitions are counted, not silently presented as a complete trace.
 */
export function reportRuntimeLiveness(): Disposable {
  // Lifetimes, not a time window: a quiet route remains attributable after its
  // entered event leaves the incident ring. Full snapshots survive IPC coalescing.
  const active = new Map<string, ExecutionEvent>();
  let precedingRequestId: number | null = null;
  const activity = (): RuntimeActivity => ({
    observedAt: Date.now(),
    active: [...active.values()],
    precedingRequestId,
  });
  let writing = false;
  let pending: ExecutionEvent | null = null;
  let omitted = 0;
  let executionEvents = 0;
  let sequence = 0;
  let heartbeatWriting = false;
  const publish = (event: ExecutionEvent) => {
    if (!process.connected || !process.send) return;
    if (writing) {
      if (pending) omitted++;
      pending = event;
      return;
    }
    writing = true;
    process.send({ kind: "execution", event, activity: activity() }, () => {
      writing = false;
      const latest = pending;
      pending = null;
      if (latest) publish(latest);
    });
  };
  const remove = observeExecution((event) => {
    if (event.activePhase === null) active.delete(event.scopeId);
    else active.set(event.scopeId, event);
    if (event.kind === "closed" && event.owner.requestId != null) precedingRequestId = event.owner.requestId;
    executionEvents++;
    publish(event);
  });
  const heartbeat = setInterval(() => {
    if (!process.connected || !process.send || heartbeatWriting) return;
    heartbeatWriting = true;
    process.send(
      {
        kind: "heartbeat",
        sequence: ++sequence,
        executionEvents,
        omitted,
        memory: process.memoryUsage(),
        activity: activity(),
      },
      () => {
        heartbeatWriting = false;
      },
    );
  }, RUNTIME_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    [Symbol.dispose]() {
      clearInterval(heartbeat);
      remove();
    },
  };
}
