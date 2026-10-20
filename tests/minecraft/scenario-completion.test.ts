import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import type { ActionResult } from "@aibengineering/mine-ai-mcp";
import { run } from "./drivers/single-action.ts";
import { run as runSequence } from "./drivers/action-sequence.ts";
import { run as runIdle } from "./drivers/idle.ts";
import type { ScenarioCall, ScenarioContext } from "./scenario.ts";

/**
 * A driver context whose YAML declares `params` and whose calls return `call`'s
 * evidence. `username` is this session's player; `players` are all the pens.
 */
function context(
  params: unknown,
  call: (action: string) => Promise<ScenarioCall>,
  { username = "Actor", players = [username], waited = [] as number[] } = {},
): ScenarioContext {
  return {
    waitForTicks: async (ticks) => { waited.push(ticks); },
    scenario: scenarioDefinitionSchema.parse({
      params,
      players: players.map((name) => ({ name })),
      goal: { kind: "completion" },
    }),
    username,
    call,
  };
}

const succeeded = async (action: string): Promise<ScenarioCall> =>
  ({ action, durationMs: 1, result: { status: "succeeded" }, summary: action });

test("a sequence stops before later actions when a step does not succeed", async () => {
  for (const status of ["partial", "failed", "cancelled"] as const) {
    const called: string[] = [];
    const completion = await runSequence(context(
      { actions: ["first", "stop", "never"].map((action) => ({ action, input: {} })) },
      async (action) => {
        called.push(action);
        const result: ActionResult = action === "first" ? { status: "succeeded" } : { status, error: "stopped" };
        return { action, durationMs: 1, result, summary: action };
      },
    ));
    assert.equal(completion.status, "failed");
    assert.deepEqual(called, ["first", "stop"]);
  }
});

test("an interruption expectation cannot pass on success alone or a different reflex", async () => {
  for (const interruptions of [undefined, ["Equip an available shield"], ["[HOSTILE_CONTACT] fight response"]]) {
    const completion = await run(context(
      { action: "collect_block", input: {}, expect: { status: "succeeded", interruptionContains: "[HOSTILE_CONTACT]" } },
      async (action) => ({ action, durationMs: 1, result: { status: "succeeded" }, summary: "collected", interruptions }),
    ));
    assert.equal(completion.status, interruptions?.[0]?.includes("HOSTILE_CONTACT") ? "succeeded" : "failed");
  }
});

// Success is the default; expected refusals must be explicit in scenario params.
test("partial, failed and cancelled actions cannot satisfy successful completion", async () => {
  for (const status of ["partial", "failed", "cancelled"] as const) {
    const result: ActionResult = { status, error: "not completed" };
    const completion = await run(context(
      { action: "collect_block", input: { block_name: "coal_ore", count: 5 } },
      async (action) => ({ action, durationMs: 1, result, summary: "not completed" }),
    ));
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
    const completion = await run(context(
      { action: "collect_block", input: {}, expect: { status: expected, errorContains: "[INVENTORY_FULL]" } },
      async (action) => ({ action, durationMs: 1, result, summary: "action evidence" }),
    ));
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
    const completion = await run(context(
      { action: "collect_block", input: {}, expect: { status: "failed", errorContains: "[INVENTORY_FULL]" } },
      async (action) => ({ action, durationMs: 1, result, summary: "runtime stopped" }),
    ));
    assert.equal(completion.status, "failed");
  }
});

test("ordinary single-action scenarios still pass without an expectation", async () => {
  const completion = await run(context(
    { action: "view_status", input: {} },
    async (action) => ({ action, durationMs: 1, result: { status: "succeeded" }, summary: "observed" }),
  ));
  assert.deepEqual(completion, { status: "succeeded", detail: "observed" });
});

test("a status list accepts any listed outcome and nothing else", async () => {
  for (const [status, passes] of [["partial", true], ["failed", true], ["succeeded", false]] as const) {
    const result: ActionResult = status === "succeeded" ? { status } : { status, error: "[HUNT_TARGET_LOST]" };
    const completion = await run(context(
      { action: "hunt", input: {}, expect: { status: ["partial", "failed"] } },
      async (action) => ({ action, durationMs: 1, result, summary: "hunted" }),
    ));
    assert.equal(completion.status, passes ? "succeeded" : "failed");
  }
});

test("a sequence step passes on its own expectation and the next step still runs", async () => {
  const called: string[] = [];
  const completion = await runSequence(context(
    {
      actions: [
        { action: "refused", input: {}, expect: { status: "failed", errorContains: "[NO_ROUTE]" } },
        { action: "after", input: {} },
      ],
    },
    async (action) => {
      called.push(action);
      return action === "refused"
        ? { action, durationMs: 1, result: { status: "failed", error: "[NO_ROUTE] sealed" }, summary: action }
        : succeeded(action);
    },
  ));
  assert.equal(completion.status, "succeeded");
  assert.deepEqual(called, ["refused", "after"]);
});

test("each pen runs only its own envelope, after its leading wait", async () => {
  const params = {
    players: {
      Hunter: { waitTicks: 40, actions: [{ action: "hunt", input: {} }] },
      Idler: { waitTicks: 200 },
    },
  };
  for (const [username, actions, ticks] of [["Hunter", ["hunt"], [40]], ["Idler", [], [200]]] as const) {
    const called: string[] = [];
    const waited: number[] = [];
    const completion = await runSequence(context(
      params,
      async (action) => { called.push(action); return succeeded(action); },
      { username, players: ["Hunter", "Idler"], waited },
    ));
    assert.equal(completion.status, "succeeded");
    assert.deepEqual(called, actions);
    assert.deepEqual(waited, ticks);
  }
});

test("a pen without a request, an empty envelope or a mixed envelope is rejected", async () => {
  const step = { action: "hunt", input: {} };
  const players = ["Hunter", "Idler"];
  for (const params of [
    { players: { Idler: { waitTicks: 20 } } },
    { players: { Hunter: {}, Idler: { waitTicks: 20 } } },
    { players: { Hunter: { actions: [] }, Idler: { waitTicks: 20 } } },
    { actions: [step], players: { Hunter: { actions: [step] }, Idler: { waitTicks: 20 } } },
    { players: { Hunter: { actions: [step] }, Idler: { waitTicks: 20 }, Typo: { waitTicks: 20 } } },
  ]) {
    await assert.rejects(runSequence(context(params, succeeded, { username: "Hunter", players })));
  }
  await assert.rejects(run(context(
    { action: "hunt", input: {}, players: { Hunter: { action: "hunt", input: {} } } },
    succeeded,
    { username: "Hunter" },
  )));
});

test("single-action reads this player's envelope", async () => {
  const called: string[] = [];
  const completion = await run(context(
    { players: { Hunter: { action: "hunt", input: {} }, Idler: { action: "view_status", input: {} } } },
    async (action) => { called.push(action); return succeeded(action); },
    { username: "Idler", players: ["Hunter", "Idler"] },
  ));
  assert.equal(completion.status, "succeeded");
  assert.deepEqual(called, ["view_status"]);
});

test("idle waits its own ticks, falling back to the scenario's, and requests nothing", async () => {
  const params = { waitTicks: 100, players: { Fighter: { waitTicks: 300 } } };
  for (const [username, ticks] of [["Fighter", 300], ["Bystander", 100]] as const) {
    const waited: number[] = [];
    const completion = await runIdle(context(
      params,
      async () => assert.fail("idle must not request an action"),
      { username, players: ["Fighter", "Bystander"], waited },
    ));
    assert.equal(completion.status, "succeeded");
    assert.deepEqual(waited, [ticks]);
  }
  await assert.rejects(runIdle(context({ players: { Fighter: { waitTicks: 1 } } }, succeeded, {
    username: "Bystander",
    players: ["Fighter", "Bystander"],
  })));
});
