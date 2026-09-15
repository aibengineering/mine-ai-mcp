import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { runNodeClient } from "mine-labs/client";
import { z } from "zod";
import { startHost, parseHostOptions } from "../../../src/index.ts";
import { incidentReferenceSchema } from "../../../src/bot-data/incident-log.ts";

const fault = z.enum(["synchronous", "microtask"]).parse(process.argv[2]);
const healthSchema = z.object({ minecraft: z.object({ connected: z.boolean() }) });
const failedHealthSchema = z.object({
  runtime: z.object({
    state: z.literal("failed"),
    failure: z.object({
      code: z.literal("RUNTIME_UNRESPONSIVE"),
      incident: incidentReferenceSchema,
    }),
  }),
});

await runNodeClient(async (session) => {
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (!artifacts) throw new Error("This destructive fault injection must run inside Mine Labs.");
  // Exercise the package's normal public host API, without a supervisor supplied
  // by the caller. Every address and all bot data belong to this fresh scenario.
  await using host = await startHost(undefined, {
    ...parseHostOptions([
      "--instance-id",
      `scenario-${fault}`,
      "--minecraft-host",
      session.host,
      "--minecraft-port",
      String(session.port),
      "--username",
      session.username,
      "--version",
      session.version,
      "--debug-execute-javascript",
      "--data-root",
      artifacts,
    ]),
    listenPort: 0,
  });
  assert.ok(host.address && typeof host.address !== "string");
  const base = `http://127.0.0.1:${host.address.port}`;
  while (true) {
    session.signal.throwIfAborted();
    const response = await fetch(`${base}/health`, { signal: session.signal });
    const status: unknown = await response.json();
    if (response.ok && healthSchema.parse(status).minecraft.connected) break;
    if (z.object({ runtime: z.object({ state: z.literal("failed") }) }).safeParse(status).success)
      throw new Error(`Runtime failed during startup: ${JSON.stringify(status)}`);
    await delay(50, undefined, { signal: session.signal });
  }
  session.ready();
  await session.arranged;
  session.prepared();
  await session.start;
  const client = new Client({ name: "host-starvation-scenario", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = (code: string) =>
      client.callTool({
        name: "debug_execute_javascript",
        arguments: {
          code,
          rationale: "Verify runtime starvation protection in an isolated physical scenario.",
          response_format: "json",
        },
      });
    const healthyStarted = performance.now();
    const healthy = await call(
      "await bot.waitForTicks(140); return { connected: bot._client.state, health: bot.health };",
    );
    assert.equal(healthy.isError, false);
    const healthyMs = performance.now() - healthyStarted;
    assert.ok(healthyMs > 5000, "Real physics must outlast the watchdog without failing.");
    session.log(`Healthy MCP action completed in ${Math.round(healthyMs)} ms.`);

    const started = performance.now();
    let failure: McpError | null = null;
    try {
      await call(fault === "synchronous" ? "while (true) {}" : "while (true) await Promise.resolve();");
    } catch (cause) {
      assert.ok(cause instanceof McpError, `Expected an MCP error response, got ${String(cause)}`);
      failure = cause;
    }
    assert.ok(failure, "The infinite loop must produce an MCP response.");
    assert.match(failure.message, /RUNTIME_UNRESPONSIVE/);
    const failureMs = performance.now() - started;
    assert.ok(failureMs < 10_000, "Failure must arrive well before Minecraft's 30-second keepalive timeout.");
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 503);
    const status = failedHealthSchema.parse(await health.json());
    const reference = status.runtime.failure.incident;
    assert.equal(reference.artifact.kind, "written");
    if (reference.artifact.kind !== "written") throw new Error("Missing saved incident.");
    const incident = await readFile(reference.artifact.path, "utf8");
    assert.match(incident, /debug_execute_javascript/);
    assert.match(incident, /"phase":"execute"/);
    assert.match(incident, /runtime_failure/);
    const evidence = {
      fault,
      healthyMs,
      failureMs,
      error: { code: failure.code, message: failure.message, data: failure.data },
      health: status,
    };
    await writeFile(path.join(artifacts, "host-starvation.json"), JSON.stringify(evidence, null, 2));
    session.finish({
      status: "succeeded",
      detail: `Healthy action ${Math.round(healthyMs)} ms; ${fault} loop returned ${failure.code} RUNTIME_UNRESPONSIVE in ${Math.round(failureMs)} ms; incident ${reference.artifact.path}`,
    });
  } finally {
    await client.close();
  }
});
