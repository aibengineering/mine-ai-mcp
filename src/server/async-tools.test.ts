import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineAction, actionResultSchema } from "../actions/action.js";
import { ActionRunner } from "../session/action-runner.js";
import { AsyncActions } from "../session/async-actions.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import { DEFAULT_SURVIVAL_POLICY } from "../survival/policy/contract.js";
import { createMinecraftMcpServer } from "./mcp.js";

test("MCP accepts immediately, retains work across client reconnect, and delivers full typed output before the successor", async (t) => {
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const runner = new ActionRunner();
  const action = defineAction({
    name: "test_foreground", description: "Test work", inputSchema: z.object({}),
    resultSchema: actionResultSchema({ collected: z.number() }), formatResult: (result) => `Collected ${result.collected}`,
    execution: { kind: "task" }, parse: () => ({}),
    execute: async () => { await done; return { status: "succeeded", collected: 3 }; },
  });
  const service = new AsyncActions(runner, runner.run);
  const statusAction = defineAction({
    name: "view_status", description: "Test status", inputSchema: z.object({}),
    resultSchema: actionResultSchema({}), formatResult: () => "Bot is connected.",
    execution: { kind: "information" }, parse: () => ({}), execute: async () => ({ status: "succeeded" }),
  });
  const records: unknown[] = [];
  let observations = 0;
  const notifications = { unreadCount: 2, recentPreview: [
    "hostile: target died; interrupted test_foreground; health 20 → 14/20",
    "hunger: ate; cooked porkchop; hunger 16 → 20/20",
  ], hint: "Use read_recent_events for full evidence." };
  function survival(): SurvivalStatus {
    const initial = observations++ === 0;
    return {
      summary: "responding", request: runner.request(),
      owner: { current: "hostile_reflex", reserved: action.name, connected: true, transfer: null },
      dangers: [], response: { capability: "hostile_reflex", kind: "fight", phase: "melee", phaseTicks: 1, startedAt: 1 },
      decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
      policy: { revision: "test", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY,
        overrides: [], encounter: null, response: null, settling: false, lastChange: "Default", constraint: null },
      vitals: { health: initial ? 20 : 14, food: initial ? 16 : 20, air: 300, inWater: false },
      runtime: { liveness: "observed_in_process", observedAt: 2, physicsObservedAt: 2 },
    };
  }
  const runtime = { actions: [action, statusAction], run: runner.run, asyncActions: service,
    status: () => ({ survival: survival() }),
    notificationSummary: () => notifications, recordActionRequest: () => records.length + 1,
    recordActionResponse: (reply: unknown) => { records.push(reply); },
  };
  async function connect() {
    const server = createMinecraftMcpServer(runtime, "TestBot");
    const client = new Client({ name: "async-contract", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s); await client.connect(c);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  }
  const client = await connect();
  const acceptedReply = await client.callTool({ name: action.name, arguments: { submission_id: "one", rationale: "Collect test items", response_format: "json" } });
  const accepted = (acceptedReply.structuredContent as { response: { data: { state: string; actionId: string } } }).response.data;
  assert.equal(accepted.state, "accepted");
  assert.equal(runner.status().busy, true);
  await client.close();
  const reconnected = await connect();
  const pendingReply = await reconnected.callTool({ name: "wait_for_action", arguments: { action_id: accepted.actionId, timeout_ms: 1, rationale: "Assess progress", response_format: "json" } });
  assert.equal((pendingReply.structuredContent as { response: { data: { state: string } } }).response.data.state, "pending");
  const pendingData = (pendingReply.structuredContent as { response: { data: { survival: SurvivalStatus; vitalsDuringWait: unknown } } }).response.data;
  assert.equal(pendingData.survival.vitals.health, 14);
  assert.deepEqual(pendingData.vitalsDuringWait, { healthBefore: 20, healthAfter: 14, foodBefore: 16, foodAfter: 20 });
  assert.deepEqual((pendingReply.structuredContent as { notifications: unknown }).notifications, notifications);
  observations = 0;
  const pendingMarkdown = await reconnected.callTool({ name: "wait_for_action", arguments: { action_id: accepted.actionId, timeout_ms: 0, rationale: "Read progress in the default format" } });
  const pendingText = (pendingMarkdown.structuredContent as { response: { markdown: string } }).response.markdown;
  assert.match(pendingText, /During this wait/);
  assert.match(pendingText, /Vitals during this wait.*Health 20 → 14/);
  assert.match(pendingText, /Automatic hostile response in progress/);
  assert.match(pendingText, /## Notifications/);
  for (const preview of notifications.recentPreview) assert.ok(pendingText.includes(preview));
  assert.equal(pendingText.match(/## Notifications/g)?.length, 1);
  assert.deepEqual(Object.keys(pendingMarkdown.structuredContent!), ["response"]);
  assert.match(pendingText, /Action progress/);
  assert.match(pendingText, /Wait timed out; the action continues/);
  assert.doesNotMatch(pendingText, /"(?:checkpoint|elapsedMs|movementCoverage)":/);
  const statusMarkdown = await reconnected.callTool({ name: "view_status", arguments: { rationale: "Inspect the retained objective in Markdown" } });
  const statusText = (statusMarkdown.structuredContent as { response: { markdown: string } }).response.markdown;
  assert.match(statusText, /Foreground action/);
  assert.match(statusText, new RegExp(accepted.actionId));
  assert.deepEqual(Object.keys(statusMarkdown.structuredContent!), ["response"], "Markdown must not carry duplicate raw progress");
  release();
  await service.settled();
  const refused = await reconnected.callTool({ name: action.name, arguments: { submission_id: "two", rationale: "Check the result retrieval gate" } });
  const refusalText = (refused.structuredContent as { response: { markdown: string } }).response.markdown;
  assert.match(refusalText.replaceAll("\\", ""), /Refused \(RESULT_NOT_RETRIEVED\)/);
  assert.equal(service.status().awaitingResult?.actionId, accepted.actionId);
  const finalReply = await reconnected.callTool({ name: "wait_for_action", arguments: { action_id: accepted.actionId, timeout_ms: 1000, rationale: "Read result", response_format: "json" } });
  const final = (finalReply.structuredContent as { response: { data: { state: string; output: { result: { collected: number } } } } }).response.data;
  assert.equal(final.state, "settled");
  assert.equal(final.output.result.collected, 3);
  assert.equal((final as { survival?: SurvivalStatus }).survival?.summary, "responding", "a settled result carries the survival status observed at retrieval");
  const second = await reconnected.callTool({ name: action.name, arguments: { submission_id: "two", rationale: "Continue after reviewing result", response_format: "json" } });
  assert.equal((second.structuredContent as { response: { data: { state: string } } }).response.data.state, "accepted");
  const markdown = await reconnected.callTool({ name: "wait_for_action", arguments: { action_id: accepted.actionId, timeout_ms: 0, rationale: "Inspect complete formatted evidence" } });
  assert.match(JSON.stringify(markdown.content), /Collected 3/);
  assert.doesNotMatch(JSON.stringify(markdown.content), /Receipt:/);
  assert.equal("receipt" in final, false);
  assert.equal((markdown.structuredContent as { response: { markdown: string } }).response.markdown.match(/## Notifications/g)?.length, 1);
  assert.match(JSON.stringify(markdown.content), /Final progress/);
  assert.doesNotMatch((markdown.structuredContent as { response: { markdown: string } }).response.markdown, /"sampledAt":/);
  const secondId = (second.structuredContent as { response: { data: { actionId: string } } }).response.data.actionId;
  await service.settled();
  assert.equal(service.status().awaitingResult?.actionId, secondId, "Rereading an older result must not release the current gate");
  await reconnected.callTool({ name: "wait_for_action", arguments: { action_id: secondId, timeout_ms: 0, rationale: "Retrieve the second result in Markdown" } });
  assert.equal(service.status().awaitingResult, null);
  assert.equal(records.length, 9);
});


test("initial waits return typed results or progress, deduplicate retries, and cancellation stops only the wait", async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const runner = new ActionRunner();
  let attempts = 0;
  const inputSchema = z.strictObject({ count: z.number() });
  const action = defineAction({
    name: "initial_work", description: "Test initial waiting", inputSchema,
    resultSchema: actionResultSchema({ count: z.number() }), formatResult: (result) => `Count: ${result.count}`,
    execution: { kind: "task" }, parse: (input) => inputSchema.parse(input),
    execute: async ({ count }) => {
      attempts++;
      if (count === 1) { started(); await gate; }
      return count < 0 ? { status: "failed", count, error: "Observed failure" } : { status: "succeeded", count };
    },
  });
  const service = new AsyncActions(runner, runner.run);
  let calls = 0;
  const server = createMinecraftMcpServer({ actions: [action], asyncActions: service, run: runner.run,
    notificationSummary: () => ({ unreadCount: 0 }), recordActionRequest: () => ++calls, recordActionResponse: () => {},
  }, "TestBot");
  const client = new Client({ name: "initial-wait", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
  t.after(async () => { release(); await service.settled(); await client.close(); await server.close(); });
  const request = (submission_id: string, count: number, wait_timeout_ms: number) => ({ name: action.name,
    arguments: { submission_id, count, wait_timeout_ms, rationale: "Observe initial work", response_format: "json" },
  });
  type Data = { state: string; code?: string; actionId: string; output?: { result: { count: number } } };
  const data = (reply: Awaited<ReturnType<Client["callTool"]>>) => (reply.structuredContent as { response: { data: Data } }).response.data;
  const fast = data(await client.callTool(request("fast", 2, 1000)));
  assert.equal(fast.state, "settled");
  assert.equal(fast.output?.result.count, 2);
  assert.equal(service.status().awaitingResult, null);
  const controller = new AbortController();
  const initial = client.callTool(request("slow", 1, 10000), undefined, { signal: controller.signal });
  const cancelled = assert.rejects(initial);
  await entered;
  controller.abort();
  await cancelled;
  assert.equal(runner.status().busy, true, "Cancelling an initial wait must preserve admitted work");
  const pending = data(await client.callTool(request("slow", 1, 0)));
  assert.equal(pending.state, "pending");
  assert.equal(data(await client.callTool(request("busy", 2, 1000))).code, "ACTION_BUSY");
  const invalid = await client.callTool(request("invalid", 2, -1));
  assert.equal(invalid.isError, true);
  assert.equal(attempts, 2);
  release();
  const final = data(await client.callTool(request("slow", 1, 1000)));
  assert.equal(final.state, "settled");
  assert.equal(final.actionId, pending.actionId);
  assert.equal(final.output?.result.count, 1);
  assert.equal(attempts, 2, "Changing wait timeout on retry must not repeat execution");
  assert.equal(service.status().awaitingResult, null);
  const markdown = await client.callTool({ name: action.name, arguments: {
    submission_id: "markdown", count: 3, wait_timeout_ms: 1000, rationale: "Read initial Markdown output",
  } });
  assert.match(JSON.stringify(markdown.content), /Count: 3/);
  assert.doesNotMatch(JSON.stringify(markdown.content), /Accepted:/);
  const failed = await client.callTool(request("failed", -1, 1000));
  assert.equal(failed.isError, true);
  assert.equal(data(failed).state, "settled");
  assert.equal(service.status().awaitingResult, null, "Delivered failures also release the gate");
});
