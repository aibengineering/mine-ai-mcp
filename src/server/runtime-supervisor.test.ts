import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { captureOutput } from "../test-support/output.js";
import { startMcpSupervisor } from "./runtime-supervisor.js";

const executable = process.execPath;
const args = [...process.execArgv, fileURLToPath(new URL("../test-support/wedged-runtime.ts", import.meta.url))];

// Every failure below is reported to the operator on stderr. The cases run
// concurrently, so the capture spans the file rather than one test.
const output = captureOutput({ after });

/**
 * A supervisor over the wedged-runtime fixture, with its own incident
 * directory; disposing it closes the supervisor and removes the directory.
 * `launch` replaces the child command, for the case where the runtime cannot
 * start at all.
 */
async function supervised(instanceId: string, launch?: (directory: string) => { executable: string; args: string[] }) {
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
  const address = supervisor.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    supervisor,
    url: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Every test acts only once the runtime is answering for itself. */
async function whenHealthy(url: string): Promise<void> {
  while (!(await fetch(`${url}/health`)).ok) await delay(20);
}

/**
 * Tests that each wait out a real liveness window: five seconds, or the
 * twenty-second incident history for attribution. The supervisor offers no
 * clock to shorten them, and Bun runs node:test cases one at a time. Their
 * runtimes are independent processes, so every case starts when the first of
 * them is reached and each test awaits its own; the file costs the longest
 * window instead of the sum. A case must not block this process, which hosts
 * every supervisor's watchdog.
 */
function concurrentTests(cases: Record<string, () => Promise<void>>): void {
  let started: Map<string, Promise<void>> | undefined;
  for (const name of Object.keys(cases)) {
    test(name, { timeout: 60_000 }, () => {
      started ??= new Map(
        Object.entries(cases).map(([key, run]) => {
          const running = run();
          // Its own test reports a failure; until then it is not unhandled.
          running.catch(() => {});
          return [key, running];
        }),
      );
      return started.get(name)!;
    });
  }
}

// Blocks this whole process, and with it every supervisor's watchdog, so it
// runs alone before the concurrent cases start.
test(
  "a shared scheduling pause gets a fresh liveness window when the supervisor resumes",
  { timeout: 15_000 },
  async () => {
    await using run = await supervised("observer-stall");
    const { url } = run;
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

/** A tool call the fixture answers by wedging or killing its event loop in the named way. */
async function supervisorSavesFailure(fault: "hang" | "microtask" | "sse-hang" | "crash") {
  await using run = await supervised(fault);
  const { url } = run;
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
  assert.equal(
    output.including(status.runtime.failure.incident.incidentId).length,
    1,
    "The operator's log names the same incident health reports.",
  );
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
}

concurrentTests({
  "retains active request and restored phase after the client and entry event are gone": async () => {
    await using run = await supervised("attribution");
    const { url } = run;
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
  "supervisor returns a saved failure when the runtime hangs": () => supervisorSavesFailure("hang"),
  "supervisor returns a saved failure when the runtime microtasks": () => supervisorSavesFailure("microtask"),
  "supervisor returns a saved failure when the runtime sse-hangs": () => supervisorSavesFailure("sse-hang"),
  "supervisor returns a saved failure when the runtime crashes": () => supervisorSavesFailure("crash"),
  "a long operation with a live event loop is not timed out": async () => {
    await using run = await supervised("healthy");
    const { supervisor, url } = run;
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
  },
});

test("a runtime launch failure stays observable and can be closed", { timeout: 5000 }, async () => {
  await using run = await supervised("launch-failure", (directory) => ({
    executable: path.join(directory, "missing-runtime-executable"),
    args: [],
  }));
  const { supervisor, url } = run;

  let body: string;
  do {
    await delay(20);
    body = await (await fetch(`${url}/health`)).text();
  } while (!body.includes('"state":"failed"'));
  assert.match(body, /RUNTIME_EXITED/);

  await Promise.all([supervisor.close(), supervisor.close()]);
});
