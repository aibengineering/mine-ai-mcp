import { reportRuntimeLiveness } from "./runtime-liveness.js";
import type { RuntimeBootstrap } from "./host.js";

// This private entrypoint can only be booted by the package's supervising host.
if (!process.send) throw new Error("Start Mine AI MCP through startHost, not its private runtime process.");
const reporting = reportRuntimeLiveness();
process.once("disconnect", () => process.exit(1));
process.once("exit", () => reporting[Symbol.dispose]());

try {
  // Our parent serializes this typed bootstrap; it is not a public input boundary.
  const { source, configuration }: RuntimeBootstrap = JSON.parse(process.argv[2]!);
  const { startRuntimeHost } = await import("./runtime-host.js");
  const host = await startRuntimeHost(source, { ...configuration, listenHost: "127.0.0.1", listenPort: 0 });
  const requestStop = (failure?: unknown) => {
    if (failure !== undefined) reportFailure(failure);
    void host.close().catch(reportFailure);
  };
  host.server.on("error", requestStop);
  process.once("SIGINT", () => requestStop());
  process.once("SIGTERM", () => requestStop());
  const address = host.server.address();
  if (!address || typeof address === "string") throw new Error("Minecraft MCP requires a TCP listener.");
  process.send?.({ kind: "ready", port: address.port });
} catch (cause) {
  process.stderr.write(`[mine-ai-mcp] ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
}

function reportFailure(cause: unknown): void {
  process.stderr.write(`[mine-ai-mcp] ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
}
