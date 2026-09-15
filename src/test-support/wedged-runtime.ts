import { createServer } from "node:http";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";
import { ExecutionScope } from "../execution/execution-scope.js";

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
      await new Promise<void>((resolve) => setTimeout(resolve, 21_000));
      while (true) {}
    });
    return;
  }
  if (request.url === "/health") {
    response.end('{"ok":true}');
    return;
  }
  if (request.url === "/slow") {
    setTimeout(() => response.end("finished"), 6000);
    return;
  }
  if (request.url === "/pause") {
    response.end("accepted");
    setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7000), 100);
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
