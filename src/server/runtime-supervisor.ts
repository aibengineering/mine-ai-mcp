import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from "node:http";
import { z } from "zod";
import { writeIncidentArtifact, type IncidentReference, type IncidentRetention } from "../bot-data/incident-log.js";
import { IncidentRecorder, type SourceIdentity } from "../diagnostics/incident-recorder.js";
import {
  RUNTIME_HEARTBEAT_MS,
  RUNTIME_UNRESPONSIVE_MS,
  runtimeMessageSchema,
  type RuntimeActivity,
} from "./runtime-liveness.js";

const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.object({ name: z.string().optional() }).optional(),
});
interface PendingRequest {
  readonly response: ServerResponse;
  readonly upstream: ClientRequest;
  readonly id: string | number | null;
  readonly method: string | null;
  readonly tool: string | null;
  readonly path: string;
  readonly httpMethod: string;
}
interface RuntimeFailure {
  readonly actionId?: string;
  readonly code: "RUNTIME_UNRESPONSIVE" | "RUNTIME_EXITED";
  readonly observedAt: string;
  readonly message: string;
  readonly incident: IncidentReference;
  readonly activity: RuntimeActivity | null;
}
type RuntimeState =
  | { kind: "starting" }
  | { kind: "ready"; port: number }
  | { kind: "failing" }
  | { kind: "failed"; failure: RuntimeFailure };

export interface McpSupervisorOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly source: SourceIdentity;
  readonly incidents: { directory: string; retention: IncidentRetention };
}

/** Public HTTP stays outside the bot's event loop, including pending MCP SSE replies. */
export async function startMcpSupervisor(options: McpSupervisorOptions) {
  // Docker binds all container interfaces; Compose restricts the published port to host loopback.
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(options.host)) throw new Error("MCP must bind to loopback or 0.0.0.0 for container port forwarding.");
  let state: RuntimeState = { kind: "starting" };
  let lastHeartbeat = performance.now();
  let observationResumedAt = lastHeartbeat;
  let lastWatchdogTick = lastHeartbeat;
  let watchdogDelayMs = 0;
  let stopping = false;
  let closing: Promise<void> | null = null;
  let child: ChildProcess | null = null;
  const pending = new Set<PendingRequest>();
  let activity: RuntimeActivity | null = null;
  let heartbeat: Extract<z.infer<typeof runtimeMessageSchema>, { kind: "heartbeat" }> | null = null;
  const recorder = new IncidentRecorder(
    { instanceId: options.instanceId, source: options.source },
    (capture) =>
      writeIncidentArtifact(
        options.incidents.directory,
        capture.trigger,
        capture.requestId,
        capture.contents,
        capture.precedingRequestId,
        options.incidents.retention,
      ),
    () => {},
  );

  const answerFailure = (response: ServerResponse, id: string | number | null, failure: RuntimeFailure) => {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `[${failure.code}] ${failure.message}`, data: failure },
    });
    if (response.headersSent) {
      if (String(response.getHeader("content-type")).includes("text/event-stream"))
        response.end(`\n\nevent: message\ndata: ${body}\n\n`);
      else response.destroy(new Error(failure.message));
      // A completed JSON-RPC exchange uses HTTP 200 even when its result is an
      // error. HTTP 503 makes the SDK discard the structured MCP error as a
      // transport failure. Observational HTTP requests still receive 503.
    } else response.writeHead(id === null ? 503 : 200, { "content-type": "application/json" }).end(body);
  };
  const fail = async (code: RuntimeFailure["code"], message: string) => {
    if (stopping || state.kind === "failed" || state.kind === "failing") return;
    state = { kind: "failing" };
    const observedAt = new Date().toISOString();
    const requestId = activity?.active.find((scope) => scope.owner.requestId != null)?.owner.requestId ?? null;
    const precedingRequestId = requestId === null ? (activity?.precedingRequestId ?? null) : null;
    recorder.record("runtime_failure", {
      code,
      message,
      pid: child?.pid,
      heartbeatAgeMs: performance.now() - lastHeartbeat,
      supervisorTickDelayMs: watchdogDelayMs,
      activity,
      activityAgeMs: activity === null ? null : Date.now() - activity.observedAt,
      pending: [...pending].map(({ id, method, tool, path, httpMethod }) => ({ id, method, tool, path, httpMethod })),
    });
    // Stop only the child we spawned. SIGKILL also covers an event loop that
    // cannot process SIGTERM; it never asks that loop to perform its own rescue.
    child?.kill("SIGKILL");
    const captured = await recorder.capture(
      code === "RUNTIME_UNRESPONSIVE" ? "runtime_unresponsive" : "runtime_exited",
      requestId,
      precedingRequestId,
    );
    const incident: IncidentReference =
      captured.kind === "completed"
        ? captured.reference
        : {
            incidentId: "supervisor-write-failed",
            trigger: code === "RUNTIME_UNRESPONSIVE" ? "runtime_unresponsive" : "runtime_exited",
            requestId,
            precedingRequestId,
            artifact: { kind: "failed", error: captured.kind === "failed" ? captured.error : "Capture was coalesced." },
          };
    const failure: RuntimeFailure = {
      ...(activity?.active.find((scope) => scope.owner.actionId)?.owner.actionId
        ? { actionId: activity.active.find((scope) => scope.owner.actionId)!.owner.actionId! } : {}),
      code,
      observedAt,
      message: `${message} Failure observed at ${observedAt}; this runtime has been stopped and requires a restart.`,
      incident,
      activity,
    };
    state = { kind: "failed", failure };
    for (const entry of pending) {
      entry.upstream.destroy();
      answerFailure(entry.response, entry.id, failure);
    }
    console.error(`[minecraft-supervisor] ${JSON.stringify(failure)}`);
  };

  const app = createMcpExpressApp({ host: options.host, allowedHosts: ["127.0.0.1", "localhost", "[::1]"] });
  app.use((request, response) => {
    if (request.method === "GET" && request.path === "/diagnostics/runtime") {
      response.json({ state: state.kind, heartbeatAgeMs: performance.now() - lastHeartbeat, activity, heartbeat });
      return;
    }
    const parsed = envelopeSchema.safeParse(request.body);
    const envelope = parsed.success ? parsed.data : null;
    if (state.kind !== "ready") {
      const failure = state.kind === "failed" ? state.failure : null;
      if (failure && request.path === "/mcp" && envelope?.id !== undefined) {
        answerFailure(response, envelope.id, failure);
        return;
      }
      response.status(503).json({
        ok: false,
        runtime: { state: state.kind, failure },
        minecraft: { connected: false },
        error: failure
          ? `[${failure.code}] ${failure.message}`
          : "Minecraft runtime is starting or saving its failure.",
      });
      return;
    }
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const headers = { ...request.headers };
    delete headers["transfer-encoding"];
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: state.port,
      method: request.method,
      path: request.originalUrl,
      headers,
    });
    const entry: PendingRequest = {
      upstream,
      response,
      id: envelope?.id ?? null,
      method: envelope?.method ?? null,
      tool: envelope?.params?.name ?? null,
      path: request.path,
      httpMethod: request.method,
    };
    pending.add(entry);
    recorder.record("http_request", { id: entry.id, method: entry.method, tool: entry.tool, path: request.path });
    upstream.on("response", (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!pending.has(entry)) return; // A cancelled HTTP request does not mean the runtime failed.
      if (state.kind === "failed") answerFailure(response, entry.id, state.failure);
      else if (state.kind !== "failing" && !stopping)
        void fail("RUNTIME_EXITED", `Runtime transport failed: ${error.message}`);
    });
    response.once("close", () => {
      pending.delete(entry);
      upstream.destroy();
    });
    upstream.end(body);
  });
  const server = createServer(app);
  // Actions and SSE have natural lifetimes; only lost event-loop liveness is timed.
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  child = spawn(options.executable, [...options.args], {
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (raw: unknown) => {
    const parsed = runtimeMessageSchema.safeParse(raw);
    if (!parsed.success || state.kind === "failed" || state.kind === "failing") return;
    const event = parsed.data;
    if (event.kind !== "ready") activity = event.activity;
    recorder.record(event.kind, event);
    if (event.kind === "heartbeat") {
      lastHeartbeat = performance.now();
      heartbeat = event;
    }
    if (event.kind === "ready") state = { kind: "ready", port: event.port };
  });
  child.once("error", (error) => {
    void fail("RUNTIME_EXITED", error.message);
  });
  child.once("exit", (code, signal) => {
    void fail("RUNTIME_EXITED", `Runtime exited: code=${code}, signal=${signal}.`);
  });
  const watchdog = setInterval(() => {
    const now = performance.now();
    watchdogDelayMs = Math.max(0, now - lastWatchdogTick - RUNTIME_HEARTBEAT_MS);
    lastWatchdogTick = now;
    // A watchdog that missed its own liveness window cannot attribute that
    // gap to the child. Resume observation before judging it; queued IPC and
    // a child recovering from the same scheduling pause get a full window.
    if (watchdogDelayMs >= RUNTIME_UNRESPONSIVE_MS) {
      observationResumedAt = now;
      recorder.record("supervisor_observation_resumed", {
        supervisorTickDelayMs: watchdogDelayMs,
        heartbeatAgeMs: now - lastHeartbeat,
      });
    }
    const age = now - Math.max(lastHeartbeat, observationResumedAt);
    if (age >= RUNTIME_UNRESPONSIVE_MS)
      void fail(
        "RUNTIME_UNRESPONSIVE",
        `Runtime event-loop heartbeat absent for ${Math.round(now - lastHeartbeat)} ms.`,
      );
  }, RUNTIME_HEARTBEAT_MS);
  const stop = async () => {
    stopping = true;
    clearInterval(watchdog);
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      // Normal disposal gets the same liveness allowance as execution. A
      // cleanup loop must not keep the owned child alive after service stop.
      const force = setTimeout(() => child?.kill("SIGKILL"), RUNTIME_UNRESPONSIVE_MS);
      try {
        await stopped;
      } finally {
        clearTimeout(force);
      }
    }
    for (const entry of pending) {
      entry.response.destroy();
      entry.upstream.destroy();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.flush();
  };
  const close = () => (closing ??= stop());
  return { server, child, close, [Symbol.asyncDispose]: close };
}
