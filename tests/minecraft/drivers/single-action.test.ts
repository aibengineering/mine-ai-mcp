import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import type { ActionResult } from "@aibengineering/mine-ai-mcp";
import { run } from "./single-action.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const scenario = (params: Record<string, unknown>) => scenarioDefinitionSchema.parse({
  params,
  goal: { kind: "completion" },
});

test("the collect fixtures resolve their shared client and forward each declared action once", async () => {
  for (const name of ["coal-outcrop", "sand-single", "oak-tree"]) {
    const scenario = await loadScenario(path.join(root, `scenarios/collect/${name}.yaml`));
    const [host, driver] = scenario.client.args;
    assert.ok(existsSync(path.resolve(scenario.client.cwd!, host!)));
    assert.ok(existsSync(path.resolve(scenario.client.cwd!, driver!)));
    const calls: unknown[] = [];
    const completion = await run({
      scenario,
      call: async (action, input) => {
        calls.push({ action, input });
        return { action, durationMs: 1, result: { status: "succeeded" }, summary: "collected" };
      },
    });
    assert.deepEqual(calls, [scenario.params]);
    assert.deepEqual(completion, { status: "succeeded", detail: "collected" });
  }
});

test("a different action uses the same driver, including an empty input", async () => {
  const calls: unknown[] = [];
  await run({
    scenario: scenario({ action: "view_status", input: {} }),
    call: async (action, input) => {
      calls.push({ action, input });
      return { action, durationMs: 1, result: { status: "succeeded" }, summary: "observed" };
    },
  });
  assert.deepEqual(calls, [{ action: "view_status", input: {} }]);
});

test("partial, failed and cancelled actions cannot satisfy successful completion", async () => {
  for (const status of ["partial", "failed", "cancelled"] as const) {
    const result: ActionResult = { status, error: "not completed" };
    const completion = await run({
      scenario: scenario({ action: "collect_block", input: { block_name: "coal_ore", count: 5 } }),
      call: async (action) => ({ action, durationMs: 1, result, summary: "not completed" }),
    });
    assert.deepEqual(completion, { status: "failed", detail: "not completed" });
  }
});

test("malformed request envelopes are rejected before calling the runtime", async () => {
  for (const params of [
    { action: "collect_block", inputs: {} },
    { action: "", input: {} },
    { action: "collect_block", input: [], expect: "succeeded" },
  ]) {
    await assert.rejects(run({
      scenario: scenario(params),
      call: async () => assert.fail("Malformed request reached the runtime"),
    }), { name: "ZodError" });
  }
});
