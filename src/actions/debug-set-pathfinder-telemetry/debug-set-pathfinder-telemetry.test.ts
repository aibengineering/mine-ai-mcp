import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationEvent } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { createDebugSetPathfinderTelemetryAction } from "./index.js";

test("debug telemetry subscribes once, writes JSON events, and disables cleanly", async () => {
  const listeners = new Set<(event: NavigationEvent) => void>();
  const lines: string[] = [];
  const action = createDebugSetPathfinderTelemetryAction(
    {
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    (line) => lines.push(line),
  );
  const runner = new ActionRunner();

  const enabled = await runner.run(action, { enabled: true });
  await runner.run(action, { enabled: true });
  assert.deepEqual(enabled.result, {
    status: "succeeded",
    telemetry: { enabled: true, destination: "mcp_host_stdout" },
  });
  assert.equal(listeners.size, 1);

  const event = { kind: "run_started", runId: "coal-run", atMs: 12 } as const;
  for (const listener of listeners) listener(event);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /pathfinder_event.*coal-run/);

  const disabled = await runner.run(action, { enabled: false });
  assert.deepEqual(disabled.result, {
    status: "succeeded",
    telemetry: { enabled: false, destination: "mcp_host_stdout" },
  });
  assert.equal(listeners.size, 0);
});
