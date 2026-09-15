import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startMcpSupervisor } from "./runtime-supervisor.js";

const executable = process.execPath;
const args = [...process.execArgv, fileURLToPath(new URL("../test-support/wedged-runtime.ts", import.meta.url))];

/**
 * A supervisor over the wedged-runtime fixture, with its own incident
 * directory, closed and removed when the test finishes. `launch` replaces the
 * child command, for the case where the runtime cannot start at all.
 */
async function supervised(
  t: TestContext,
  instanceId: string,
  launch?: (directory: string) => { executable: string; args: string[] },
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `mcp-watchdog-${instanceId}-`));
  const child = launch?.(directory) ?? { executable, args };
  const supervisor = await startMcpSupervisor({
    ...child,
    host: "127.0.0.1",
    port: 0,
    instanceId,
    source: { kind: "unavailable", reason: "test fixture" },
    incidents: { directory, retention: { days: 1, maxBytes: 1024 * 1024 } },
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = supervisor.server.address();
  assert.ok(address && typeof address !== "string");
  return { supervisor, url: `http://127.0.0.1:${address.port}` };
}

/** Every test acts only once the runtime is answering for itself. */
async function whenHealthy(url: string): Promise<void> {
  while (!(await fetch(`${url}/health`)).ok) await delay(20);
}

test(
  "a shared scheduling pause gets a fresh liveness window when the supervisor resumes",
  { timeout: 15_000 },
  async (t) => {
    const { url } = await supervised(t, "observer-stall");
    await whenHealthy(url);
    await delay(350);
    assert.equal(await (await fetch(`${url}/pause`)).text(), "accepted");
    // Pause both loops, with the child resuming half a second later. The
    // supervisor cannot diagnose a child-only hang during its own blind gap.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        resolve();
      }, 100),
    );
    await delay(1000);

    assert.equal((await fetch(`${url}/health`)).status, 200);
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    assert.ok(
      diagnostics.heartbeatAgeMs < 1000,
      "Fresh child heartbeats must resume after the supervisor can observe them.",
    );
  },
);

test(
  "retains active request and restored phase after the client and entry event are gone",
  { timeout: 40_000 },
  async (t) => {
    const { url } = await supervised(t, "attribution");
    await whenHealthy(url);
    assert.equal(await (await fetch(`${url}/background`)).text(), "accepted");
    await delay(350);
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    assert.equal(diagnostics.activity.active[0].owner.requestId, 812);
    assert.ok(diagnostics.heartbeat.memory.rss > 0);

    // Outlast the liveness window so the supervisor declares the failure itself.
    await delay(21_500);

    assert.equal((await fetch(`${url}/health`)).status, 503);
    const status = await (await fetch(`${url}/health`)).json();
    const reference = status.runtime.failure.incident;
    assert.equal(status.runtime.failure.actionId, "background-action-812");
    assert.equal(status.runtime.failure.activity.active[0].owner.requestId, 812);
    assert.equal(reference.requestId, 812);
    const records = (await readFile(reference.artifact.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].requestId, 812);
    assert.ok(!records.some((row) => row.kind === "execution"), "The original transitions have aged out.");
    const failure = records.find((row) => row.kind === "runtime_failure");
    assert.equal(failure.activity.active.length, 1);
    assert.equal(failure.activity.active[0].owner.operation, "navigate");
    assert.equal(failure.activity.active[0].activePhase, "route", "Nested return must restore the outer phase.");
    assert.ok(
      failure.pending.every(
        (entry: { tool: string | null; path: string }) => entry.tool === null && entry.path === "/health",
      ),
    );
  },
);

for (const fault of ["hang", "microtask", "sse-hang", "crash"] as const) {
  test(`supervisor returns a saved failure when the runtime ${fault}s`, { timeout: 20_000 }, async (t) => {
    const { url } = await supervised(t, fault);
    await whenHealthy(url);

    const response = await fetch(`${url}/${fault}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: fault } }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, "MCP errors must remain protocol responses, not transport errors.");
    assert.match(body, fault === "crash" ? /RUNTIME_EXITED/ : /RUNTIME_UNRESPONSIVE/);
    assert.match(body, /"id":73/);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 503);
    const status = await health.json();
    assert.equal(status.runtime.state, "failed");
    assert.ok(Number.isFinite(Date.parse(status.runtime.failure.observedAt)));
    assert.match(status.runtime.failure.message, /runtime has been stopped and requires a restart/);
    assert.equal(status.runtime.failure.incident.artifact.kind, "written");
    const incident = await readFile(status.runtime.failure.incident.artifact.path, "utf8");
    assert.match(incident, /runtime_failure/);
    assert.match(incident, /"tool":"(?:hang|microtask|sse-hang|crash)"/);
    if (fault !== "crash") assert.match(incident, /fault_injection/);

    const subsequent = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 74, method: "tools/list" }),
    });
    assert.equal(subsequent.status, 200);
    assert.match(await subsequent.text(), /"id":74/);
  });
}

test("a long operation with a live event loop is not timed out", { timeout: 15_000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "healthy");
  await whenHealthy(url);

  const cancellation = new AbortController();
  const cancelled = fetch(`${url}/slow`, { signal: cancellation.signal });
  await delay(50);
  cancellation.abort();
  await assert.rejects(cancelled);

  assert.equal((await fetch(`${url}/health`)).status, 200, "Client cancellation must not kill a healthy runtime.");
  assert.equal(await (await fetch(`${url}/slow`)).text(), "finished");
  assert.equal((await fetch(`${url}/health`)).status, 200);
  await supervisor.close();
  assert.ok(supervisor.child.exitCode !== null || supervisor.child.signalCode !== null, "close must reap its runtime.");
});

test("a runtime launch failure stays observable and can be closed", { timeout: 5000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "launch-failure", (directory) => ({
    executable: path.join(directory, "missing-runtime-executable"),
    args: [],
  }));

  let body: string;
  do {
    await delay(20);
    body = await (await fetch(`${url}/health`)).text();
  } while (!body.includes('"state":"failed"'));
  assert.match(body, /RUNTIME_EXITED/);

  await Promise.all([supervisor.close(), supervisor.close()]);
});
