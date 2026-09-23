import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import type { ActionResult } from "@aibengineering/mine-ai-mcp";
import { run } from "./drivers/single-action.ts";
import { run as runSequence } from "./drivers/action-sequence.ts";

test("a sequence stops before later actions when a step does not succeed", async () => {
  for (const status of ["partial", "failed", "cancelled"] as const) {
    const called: string[] = [];
    const completion = await runSequence({
      waitForTicks: async () => {},
      scenario: scenarioDefinitionSchema.parse({
        params: { actions: ["first", "stop", "never"].map((action) => ({ action, input: {} })) },
        goal: { kind: "completion" },
      }),
      call: async (action) => {
        called.push(action);
        const result: ActionResult = action === "first" ? { status: "succeeded" } : { status, error: "stopped" };
        return { action, durationMs: 1, result, summary: action };
      },
    });
    assert.equal(completion.status, "failed");
    assert.deepEqual(called, ["first", "stop"]);
  }
});

test("an interruption expectation cannot pass on success alone or a different reflex", async () => {
  for (const interruptions of [undefined, ["Equip an available shield"], ["[HOSTILE_CONTACT] fight response"]]) {
    const completion = await run({
      waitForTicks: async () => {},
      scenario: scenarioDefinitionSchema.parse({
        params: { action: "collect_block", input: {}, expect: { status: "succeeded", interruptionContains: "[HOSTILE_CONTACT]" } },
        goal: { kind: "completion" },
      }),
      call: async (action) => ({ action, durationMs: 1, result: { status: "succeeded" }, summary: "collected", interruptions }),
    });
    assert.equal(completion.status, interruptions?.[0]?.includes("HOSTILE_CONTACT") ? "succeeded" : "failed");
  }
});

// Success is the default; expected refusals must be explicit in scenario params.
test("partial, failed and cancelled actions cannot satisfy successful completion", async () => {
  for (const status of ["partial", "failed", "cancelled"] as const) {
    const result: ActionResult = { status, error: "not completed" };
    const completion = await run({
      waitForTicks: async () => {},
      scenario: scenarioDefinitionSchema.parse({
        params: { action: "collect_block", input: { block_name: "coal_ore", count: 5 } },
        goal: { kind: "completion" },
      }),
      call: async (action) => ({ action, durationMs: 1, result, summary: "not completed" }),
    });
    assert.equal(completion.status, "failed");
    assert.match(completion.detail ?? "", /not completed/);
  }
});

test("explicit expectations require both the action status and literal error text", async () => {
  const cases = [
    { expected: "partial", status: "partial", error: "[INVENTORY_FULL] No space.", passes: true },
    { expected: "failed", status: "failed", error: "[INVENTORY_FULL] No space.", passes: true },
    { expected: "partial", status: "failed", error: "[INVENTORY_FULL] No space.", passes: false },
    { expected: "partial", status: "partial", error: "[NO_LOADED_MATCHING_TARGETS]", passes: false },
    { expected: "partial", status: "partial", error: "I", passes: false },
    { expected: "partial", status: "succeeded", error: "", passes: false },
  ] as const;
  for (const { expected, status, error, passes } of cases) {
    const result: ActionResult = status === "succeeded" ? { status } : { status, error };
    const completion = await run({
      waitForTicks: async () => {},
      scenario: scenarioDefinitionSchema.parse({
        params: { action: "collect_block", input: {}, expect: { status: expected, errorContains: "[INVENTORY_FULL]" } },
        goal: { kind: "completion" },
      }),
      call: async (action) => ({ action, durationMs: 1, result, summary: "action evidence" }),
    });
    assert.equal(completion.status, passes ? "succeeded" : "failed");
    if (!passes) assert.match(completion.detail ?? "", /Expected .*INVENTORY_FULL.*action evidence/);
  }
});

test("expected failure cannot accept runtime failures or cancellations", async () => {
  for (const result of [
    { kind: "runtime_failure", status: "failed", error: "[INVENTORY_FULL]" },
    { kind: "runtime_failure", status: "cancelled", error: "[INVENTORY_FULL]" },
    { status: "cancelled", error: "[INVENTORY_FULL]" },
  ] as const) {
    const completion = await run({
      waitForTicks: async () => {},
      scenario: scenarioDefinitionSchema.parse({
        params: { action: "collect_block", input: {}, expect: { status: "failed", errorContains: "[INVENTORY_FULL]" } },
        goal: { kind: "completion" },
      }),
      call: async (action) => ({ action, durationMs: 1, result, summary: "runtime stopped" }),
    });
    assert.equal(completion.status, "failed");
  }
});

test("ordinary single-action scenarios still pass without an expectation", async () => {
  const completion = await run({
    waitForTicks: async () => {},
    scenario: scenarioDefinitionSchema.parse({
      params: { action: "view_status", input: {} }, goal: { kind: "completion" },
    }),
    call: async (action) => ({ action, durationMs: 1, result: { status: "succeeded" }, summary: "observed" }),
  });
  assert.deepEqual(completion, { status: "succeeded", detail: "observed" });
});
