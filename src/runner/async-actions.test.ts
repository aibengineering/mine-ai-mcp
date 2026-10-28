import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { defineAction, actionResultSchema } from "../actions/action.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { deferred } from "../test-support/async.js";
import { ActionRunner } from "./action-runner.js";
import { AsyncActions, ExecutionStore } from "./async-actions.js";

function fixture() {
  const gate = deferred();
  let attempts = 0;
  const runner = new ActionRunner({ position: () => ({ dimension: "overworld", x: 0, y: 64, z: 0 }) });
  const action = defineAction({
    name: "work", description: "Retain observed work", inputSchema: z.object({ count: z.number().default(1) }),
    resultSchema: actionResultSchema({ count: z.number() }), formatResult: (result) => `Count: ${result.count}`,
    execution: { kind: "task" }, parse: (input) => z.object({ count: z.number().default(1) }).parse(input),
    execute: async ({ count }, context) => {
      attempts++;
      context.observeProgress?.(() => ({ baseline: 0, checkpoint: { gained: attempts }, completion: { kind: "current", observed: false, owes: "Finish work" } }));
      await Promise.race([gate.promise, new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      context.signal?.throwIfAborted();
      return { status: "succeeded", count };
    },
  });
  const service = new AsyncActions(runner, runner.run);
  return { runner, service, action, finish: () => gate.resolve(), attempts: () => attempts };
}

test("submission deduplicates, timed waits preserve execution, and final retrieval gates the successor", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "first" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const poll = await f.service.wait(accepted.actionId, 0);
  assert.equal(poll.state, "pending");
  assert.equal(f.service.submit(f.action, {}, { submission_id: "first" }, 2).state, "accepted");
  assert.equal(f.service.submit(f.action, { count: 2 }, { submission_id: "first" }, 3).state, "refused");
  assert.equal(f.service.submit(f.action, {}, { submission_id: "second" }, 4).state, "refused");
  const abort = new AbortController();
  const waiting = f.service.wait(accepted.actionId, 10000, abort.signal);
  abort.abort(new Error("Stop only this wait"));
  await assert.rejects(waiting, /Stop only this wait/);
  assert.equal(f.runner.status().busy, true);
  await pause(5);
  f.finish();
  await f.service.settled();
  const refused = f.service.submit(f.action, {}, { submission_id: "second" }, 5);
  assert.equal(refused.state, "refused");
  if (refused.state === "refused") assert.equal(refused.code, "RESULT_NOT_RETRIEVED");
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  f.service.cancel(accepted.actionId, "Already finished");
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.service.wait(accepted.actionId, 0, aborted.signal));
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  const final = await f.service.wait(accepted.actionId, 1000);
  assert.equal(final.state, "settled"); if (final.state !== "settled") return;
  assert.equal(final.output.result.status, "succeeded");
  assert.equal(f.attempts(), 1);
  assert.deepEqual(await f.service.wait(accepted.actionId, 0), final);
  assert.equal(f.service.status().awaitingResult, null);
  const next = f.service.submit(f.action, {}, { submission_id: "second" }, 6);
  assert.equal(next.state, "accepted");
  if (next.state === "accepted") await f.service.wait(next.actionId, 1000);
  assert.deepEqual(await f.service.wait(accepted.actionId, 0), final);
});

test("targeted cancellation leaves a reflex alive, waits for release, and never cancels a newer ID", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "first" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  await pause(0);
  let release!: () => void;
  let reflexSignal: AbortSignal | null = null;
  const claim = f.runner.claim("hostile", "defend", async (signal) => {
    reflexSignal = signal;
    await new Promise<void>((resolve) => { release = resolve; });
    return { value: null, continuation: { kind: "resume" } };
  });
  await pause(0);
  f.service.cancel(accepted.actionId, "Choose a different objective");
  assert.equal((reflexSignal as AbortSignal | null)?.aborted, false);
  assert.equal((await f.service.wait(accepted.actionId, 0)).state, "pending");
  release();
  if (claim.kind === "claimed") await claim.outcome;
  const result = await f.service.wait(accepted.actionId, 1000);
  assert.equal(result.state, "settled");
  assert.equal(f.attempts(), 1);
  assert.equal(f.service.cancel("unknown", "old ID").state, "refused");
  if (result.state === "settled") {
    assert.equal("error" in result.output.result ? result.output.result.error : "", "Choose a different objective");
    const successor = f.service.submit(f.action, {}, { submission_id: "successor" }, 2);
    assert.equal(successor.state, "accepted");
    f.service.cancel(accepted.actionId, "Stale cancellation");
    assert.equal(f.runner.status().busy, true);
    f.finish();
    if (successor.state === "accepted") assert.equal((await f.service.wait(successor.actionId, 1000)).state, "settled");
  }
});

test("storage failure retains the result gate without repeating physical work", async (t) => {
  const data = temporaryBotData({ botId: "AsyncBot", closeAfter: t });
  const store = new ExecutionStore(data, "AsyncBot");
  const f = fixture();
  let fail = true;
  let failRetrieval = false;
  const service = new AsyncActions(f.runner, f.runner.run, {
    load: () => store.load(), write: (records) => { if (fail || (failRetrieval && records.some((record) => record.resultRetrieved))) throw new Error("Disk unavailable"); store.write(records); },
  });
  assert.equal(service.submit(f.action, {}, { submission_id: "durable" }, 1).state, "refused");
  assert.equal(f.attempts(), 0);
  fail = false;
  const first = service.submit(f.action, {}, { submission_id: "durable" }, 1, "Original intent");
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  fail = true;
  f.finish();
  const unpersisted = await service.wait(first.actionId, 1000);
  assert.equal(unpersisted.state, "storage_failed");
  assert.equal(service.status().awaitingResult?.actionId, first.actionId);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  assert.equal(f.attempts(), 1);
  fail = false;
  failRetrieval = true;
  assert.equal((await service.wait(first.actionId, 0)).state, "storage_failed");
  assert.equal(store.load()[0]?.resultRetrieved, false);
  assert.equal(service.status().awaitingResult?.actionId, first.actionId);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  failRetrieval = false;
  const final = await service.wait(first.actionId, 0);
  assert.equal(final.state, "settled"); if (final.state !== "settled") return;
  assert.equal(service.submit(f.action, { count: "invalid" }, { submission_id: "next" }, 2).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  let release!: () => void;
  const reflex = f.runner.claim("idle-protection", "Protect the idle bot", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { value: null, continuation: { kind: "resume" as const } };
  });
  await pause(0);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  release();
  if (reflex.kind === "claimed") await reflex.outcome;
  fail = true;
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 3).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  fail = false;
  const next = service.submit(f.action, {}, { submission_id: "next" }, 4);
  assert.equal(next.state, "accepted");
  if (next.state === "accepted") await service.wait(next.actionId, 1000);
  assert.equal(store.load()[0]?.rationale, "Original intent");
  assert.deepEqual(await service.wait(first.actionId, 0), final);
});

test("concurrent waits retain independent baselines and dispose their own abort listeners", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "waiters" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const controller = new AbortController();
  const first = f.service.wait(accepted.actionId, 1000, controller.signal);
  const poll = await f.service.wait(accepted.actionId, 5, controller.signal);
  assert.equal(poll.state, "pending");
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const second = f.service.wait(accepted.actionId, 1000, controller.signal);
  f.finish();
  assert.deepEqual(await first, await second);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a broken progress reader reports missing evidence without replacing the physical result", async () => {
  const f = fixture();
  const action = defineAction({ ...f.action, execute: async (_request, context) => {
    context.observeProgress?.(() => { throw new Error("World observation unavailable"); });
    return { status: "succeeded" as const, count: 7 };
  } });
  const accepted = f.service.submit(action, {}, { submission_id: "broken-reader" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const result = await f.service.wait(accepted.actionId, 1000);
  assert.equal(result.state, "settled"); if (result.state !== "settled") return;
  assert.equal(result.output.result.status, "succeeded");
  assert.equal(result.output.request?.evidence, null);
  assert.match(result.output.request?.observationError ?? "", /World observation unavailable/);
});

test("retained storage recovers unread results and interrupts unfinished work without replay", async (t) => {
  const data = temporaryBotData({ botId: "AsyncBot", closeAfter: t });
  const f = fixture();
  const store = new ExecutionStore(data, "AsyncBot");
  const service = new AsyncActions(f.runner, f.runner.run, store);
  const accepted = service.submit(f.action, {}, { submission_id: "durable" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const recovered = new AsyncActions(new ActionRunner(), f.runner.run, store);
  assert.equal(recovered.status().awaitingResult?.actionId, accepted.actionId);
  const result = await recovered.wait(accepted.actionId, 0);
  assert.equal(result.state, "settled");
  if (result.state === "settled") {
    assert.equal(result.output.result.status, "failed");
    assert.match("error" in result.output.result ? result.output.result.error : "", /RUNTIME_INTERRUPTED/);
    assert.equal(recovered.status().awaitingResult, null);
  }
  f.finish();
  await service.wait(accepted.actionId, 1000);
  const latest = new AsyncActions(new ActionRunner(), f.runner.run, store);
  assert.equal(latest.status().awaitingResult, null);
  assert.equal(latest.submit(f.action, {}, { submission_id: "durable" }, 2).state, "accepted");
  assert.equal(f.attempts(), 1);
});
