#!/usr/bin/env bun
/** The public host always owns a supervised bot process. */
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceIdentity } from "../diagnostics/incident-recorder.js";
import { parseHostOptions, type HostOptions } from "./config.js";
import { startMcpSupervisor } from "./runtime-supervisor.js";

/** Private parent-to-child bootstrap, written only by this package's host. */
export interface RuntimeBootstrap {
  readonly source: SourceIdentity;
  readonly configuration: HostOptions;
}

export interface Host extends AsyncDisposable {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function startHost(
  source: SourceIdentity = { kind: "unavailable", reason: "No source identity supplied by the host caller." },
  configuration = parseHostOptions(),
): Promise<Host> {
  const bootstrap: RuntimeBootstrap = { source, configuration };
  // Use the sibling in this installation, both from TypeScript and built JS.
  const runtimeFile = new URL(
    import.meta.url.endsWith(".ts") ? "./runtime-process.ts" : "./runtime-process.js",
    import.meta.url,
  );
  const supervisor = await startMcpSupervisor({
    executable: process.execPath,
    args: [...process.execArgv, fileURLToPath(runtimeFile), JSON.stringify(bootstrap)],
    host: configuration.listenHost,
    port: configuration.listenPort,
    instanceId: configuration.instanceId,
    source,
    incidents: {
      directory: path.join(
        configuration.botData.storage.kind === "persistent"
          ? configuration.botData.storage.root
          : path.join(os.tmpdir(), "mine-ai"),
        "host-incidents",
        encodeURIComponent(configuration.instanceId),
      ),
      retention: configuration.incidentRetention,
    },
  });
  const address = supervisor.server.address();
  if (!address || typeof address === "string") throw new Error("Minecraft MCP requires a TCP listener.");
  const exit = () => {
    supervisor.child.kill("SIGKILL");
  };
  const close = async () => {
    await supervisor.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("exit", exit);
  };
  const stop = () => {
    void close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", exit);
  process.stdout.write(
    `[mine-ai-mcp] ${configuration.instanceId} host listening at http://${configuration.listenHost}:${address.port}/mcp; runtime starting.\n`,
  );
  return { address, close, [Symbol.asyncDispose]: close };
}

if (import.meta.main) {
  void startHost().catch((cause) => {
    process.stderr.write(`[mine-ai-mcp] ${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exitCode = 1;
  });
}
