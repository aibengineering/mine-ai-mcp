import { createServer } from "node:http";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";
import { ExecutionScope } from "../execution/execution-scope.js";

/**
 * The fixture's own waits, scaled by the test to the supervisor's shortened
 * liveness windows: how long a background action lives before wedging (longer
 * than the incident history), how long a slow request takes (longer than the
 * liveness window), and how long a pause blocks this loop.
 */
const timing = JSON.parse(process.argv[2] ?? "") as {
  readonly wedgeAfterMs: number;
  readonly slowMs: number;
  readonly pauseMs: number;
};

reportRuntimeLiveness();
process.once("disconnect", () => process.exit(0));
const server = createServer(async (request, response) => {
  if (request.url === "/background") {
    // The client has gone away and the entry transition will be older than the
    // incident ring when a callback blocks. Attribution must outlive both.
    const execution = new ExecutionScope({
      bot: "WatchdogTest",
      operation: "navigate",
      targetId: null,
      requestId: 812,
      actionId: "background-action-812",
    });
    void execution.run("route", async () => {
      await execution.run("brief_nested_phase", async () => {});
      response.end("accepted");
      await new Promise<void>((resolve) => setTimeout(resolve, timing.wedgeAfterMs));
      while (true) {}
    });
    return;
  }
  if (request.url === "/health") {
    response.end('{"ok":true}');
    return;
  }
  if (request.url === "/slow") {
    setTimeout(() => response.end("finished"), timing.slowMs);
    return;
  }
  if (request.url === "/pause") {
    response.end("accepted");
    setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timing.pauseMs), 100);
    return;
  }
  if (request.url === "/crash") {
    process.exit(23);
  }
  if (request.url === "/sse-hang") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": ready\n\n");
  }
  using execution = new ExecutionScope({ bot: "WatchdogTest", operation: "fault_injection", targetId: null });
  await execution.run(request.url ?? "unknown", async () => {
    if (request.url === "/microtask") while (true) await Promise.resolve();
    while (true) {} // Deliberately bypasses cooperative checkpoints.
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
