import { getAmbientHighlighterContext } from "@aibengineering/minecraft-block-highlighter";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { z } from "zod";
import {
  defineAction,
  actionResultSchema,
  type Action,
  type ActionExecution,
} from "../actions/index.js";
import { ReflexDriver } from "../survival/control/driver.js";
import { attachFootingReflex } from "../survival/reflexes/footing.js";
import { deferred, nextTurn } from "../test-support/async.js";
import { BodyAbort } from "./abort.js";
import { ActionRunner } from "./action-runner.js";

const stubInputSchema = z.object({ block_name: z.string().optional() });
const stubResultSchema = actionResultSchema({});
type StubResult = z.output<typeof stubResultSchema>;
type StubAction = Action<"stub", { block_name: string }, StubResult>;

/** One stub action so the runner is tested without any physics. */
function stubAction(
  execute: NonNullable<StubAction["execute"]>,
  execution: ActionExecution = { kind: "task" },
): StubAction {
  return defineAction({
    name: "stub",
    description: "stub",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    parse: (input: unknown) => {
      const request = stubInputSchema.parse(input);
      if (!request.block_name) throw new Error("block_name is required.");
      return { block_name: request.block_name };
    },
    ...(execution.kind === "resumable_task"
      ? {
          execution,
          begin: (request: { block_name: string }) => (context: Parameters<typeof execute>[1]) =>
            execute(request, context),
        }
      : { execution, execute }),
  });
}

/** A task that yields to any abort by throwing its reason, and counts its runs. */
function preemptible(runs: { count: number }, execution: ActionExecution): StubAction {
  return stubAction(async (_request, context) => {
    runs.count += 1;
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw context.signal?.reason;
  }, execution);
}

/** Let the executor start: the runner prepares a task a microtask after `run` returns. */
async function started(runs: { count: number }, count: number): Promise<void> {
  for (let turn = 0; turn < 50 && runs.count < count; turn += 1) await nextTurn();
  assert.equal(runs.count, count);
}

async function untilOwner(runner: ActionRunner, owner: string): Promise<void> {
  for (let turn = 0; turn < 50 && runner.status().owner !== owner; turn += 1) await nextTurn();
  assert.equal(runner.status().owner, owner);
}

// ── Admission and the foreground action ──────────────────────────────────────

test("a task owns the preparation that runs before its executor", async () => {
  const calls: string[] = [];
  const action = stubAction(
    async () => {
      calls.push("execute");
      return { status: "succeeded" };
    },
    {
      kind: "task",
      prepare: () => {
        calls.push("prepare");
      },
    },
  );

  await new ActionRunner().run(action, { block_name: "sand" });

  assert.deepEqual(calls, ["prepare", "execute"]);
});

test("the action runner admits only one action at a time", async () => {
  const gate = deferred();
  const action = stubAction(async () => {
    await gate.promise;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const first = runner.run(action, { block_name: "sand" });
  assert.equal(runner.status().busy, true);
  const refused = await runner.run(action, { block_name: "sand" });
  assert.equal(refused.result.status, "failed");
  assert.match(refused.result.error, /ACTION_BUSY/);
  gate.resolve();
  await first;
  assert.equal(runner.status().busy, false);
});

test("the action runner measures an action and combines caller cancellation with its owned signal", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const action = stubAction(async (_request, context) => {
    observed = context.signal;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" }, controller.signal);

  assert.notEqual(observed, controller.signal);
  assert.equal(observed?.aborted, false);
  assert.deepEqual(Object.keys(output).sort(), ["action", "durationMs", "progress", "request", "result"]);
  assert.deepEqual(output.result, { status: "succeeded" });
});

test("a control action can cancel the foreground action while the session is busy", async () => {
  const runner = new ActionRunner();
  const run = runner.run;
  const cancelActive = runner.cancelActive;
  const foreground = stubAction(
    async (_request, context) =>
      new Promise<StubResult>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      }),
  );
  const control = stubAction(
    async () => {
      const cancellation = cancelActive("coal collection stopped by test");
      assert.equal(cancellation.kind, "cancellation_requested");
      return { status: "succeeded" };
    },
    { kind: "control" },
  );

  const running = run(foreground, { block_name: "coal_ore" });
  const cancelled = await run(control, { block_name: "coal_ore" });
  const foregroundOutcome = await running;

  assert.deepEqual(cancelled.result, { status: "succeeded" });
  assert.deepEqual(foregroundOutcome.result, {
    kind: "runtime_failure",
    status: "cancelled",
    error: "coal collection stopped by test",
  });
  assert.equal(runner.status().busy, false);
});

test("bad arguments fail before execution starts", async () => {
  let started = false;
  const action = stubAction(async () => {
    started = true;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const refused = await runner.run(action, {});

  assert.equal(refused.result.status, "failed");
  assert.match(refused.result.error, /\[INVALID_ARGUMENTS\] block_name is required/);
  assert.equal(started, false);
});

test("the action runner reports an executor throw without inventing action evidence", async () => {
  const action = stubAction(async () => {
    throw new Error("physics failed");
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" });

  assert.deepEqual(output.result, { kind: "runtime_failure", status: "failed", error: "physics failed" });
  assert.deepEqual(action.outputSchema.parse(output), output);
});

test("the action runner owns cancellation of an interrupted executor", async () => {
  const controller = new AbortController();
  const action = stubAction(async () => {
    controller.abort(new Error("operator stopped"));
    throw controller.signal.reason;
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" }, controller.signal);

  assert.deepEqual(output.result, { kind: "runtime_failure", status: "cancelled", error: "operator stopped" });
  assert.deepEqual(action.outputSchema.parse(output), output);
});

test("an action without a highlighter skips collection display work", async () => {
  let visited = 0;
  const action = stubAction(async () => {
    assert.equal(getAmbientHighlighterContext()?.enabled, false);
    const position = { get x() { visited++; return 0; }, y: 0, z: 0 };
    await [position].toHighlightableBlocks().highlight("#ffffff");
    return { status: "succeeded" };
  });
  const output = await new ActionRunner().run(action, { block_name: "stone" });
  assert.equal(output.result.status, "succeeded");
  assert.equal(visited, 0);
});

// ── Reflex claims on the body ────────────────────────────────────────────────

test("a claim waits for the interrupted owner to settle and keeps the session exclusive", async () => {
  const interruptedMaySettle = deferred();
  let claimStarted = false;
  const foreground = stubAction(async (_request, context) => {
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    await interruptedMaySettle.promise;
    throw context.signal?.reason;
  });
  const runner = new ActionRunner();

  const foregroundOutcome = runner.run(foreground, { block_name: "coal_ore" });
  const admission = runner.claim("hostile_reflex", "hostile contact", async () => {
    claimStarted = true;
    return { value: "engaged", continuation: { kind: "return" as const, reason: null } };
  });

  assert.equal(admission.kind, "claimed");
  assert.equal(runner.status().owner, "yielding");
  assert.equal(claimStarted, false);
  const refused = await runner.run(foreground, { block_name: "stone" });
  assert.ok("error" in refused.result);
  assert.match(refused.result.error, /ACTION_BUSY/);

  interruptedMaySettle.resolve();
  const interrupted = await foregroundOutcome;
  assert.deepEqual(interrupted.result, {
    kind: "runtime_failure",
    status: "cancelled",
    error: "hostile contact",
  });
  if (admission.kind !== "claimed") return;
  assert.equal(admission.interrupted?.action, "stub");
  assert.equal(await admission.outcome, "engaged");
  assert.equal(claimStarted, true);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a reflex may claim an idle body, and the claim refuses actions while it runs", async () => {
  const reflexMayFinish = deferred();
  const foreground = stubAction(async () => ({ status: "succeeded" }));
  const runner = new ActionRunner();

  assert.equal(runner.status().owner, "idle");
  const admission = runner.claim("hostile_reflex", "hostile contact", async () => {
    await reflexMayFinish.promise;
    return { value: "engaged", continuation: { kind: "return" as const, reason: null } };
  });

  assert.equal(admission.kind, "claimed");
  if (admission.kind !== "claimed") return;
  assert.equal(admission.interrupted, null);
  assert.equal(runner.status().owner, "takeover");
  assert.equal(runner.status().activeAction?.action, "hostile_reflex");

  const refused = await runner.run(foreground, { block_name: "stone" });
  assert.ok("error" in refused.result);
  assert.match(refused.result.error, /ACTION_BUSY/);

  reflexMayFinish.resolve();
  assert.equal(await admission.outcome, "engaged");
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("an information action answers while a reflex owns the body", async () => {
  const runner = new ActionRunner();
  const held = deferred();
  const claim = runner.claim("reflex", "test", async () => {
    await held.promise;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(claim.kind, "claimed");
  const read = stubAction(async () => ({ status: "succeeded" }), { kind: "information" });
  const output = await runner.run(read, { block_name: "stone" });
  assert.deepEqual(output.result, { status: "succeeded" });
  held.resolve();
  await (claim as { outcome: Promise<unknown> }).outcome;
});

test("a second claim is refused while a reflex owns the body", async () => {
  const reflexMayFinish = deferred();
  const runner = new ActionRunner();

  const first = runner.claim("hostile_reflex", "hostile contact", async () => {
    await reflexMayFinish.promise;
    return { value: "first", continuation: { kind: "return" as const, reason: null } };
  });
  const second = runner.claim("hostile_reflex", "hostile contact", async () => ({
    value: "second",
    continuation: { kind: "return" as const, reason: null },
  }));

  assert.equal(second.kind, "busy");
  if (second.kind !== "busy") return;
  assert.equal(second.activeAction.action, "hostile_reflex");

  reflexMayFinish.resolve();
  assert.equal(first.kind === "claimed" ? await first.outcome : null, "first");
});

test("cancelling the active owner aborts a running claim", async () => {
  const runner = new ActionRunner();
  const admission = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { value: signal.reason, continuation: { kind: "return" as const, reason: null } };
  });

  const cancellation = runner.cancelActive("Minecraft runtime closed");

  assert.equal(cancellation.kind, "cancellation_requested");
  const cause = admission.kind === "claimed" ? await admission.outcome : null;
  assert.ok(cause instanceof BodyAbort);
  assert.equal(cause.message, "Minecraft runtime closed");
  assert.deepEqual(cause.detail, { kind: "cancelled", by: "model" });
});

test("higher priority reflexes request cancellation but cannot drive until the previous owner releases", async () => {
  const runner = new ActionRunner();
  let ownedSignal: AbortSignal | null = null;
  const releasing = deferred();
  const lower = runner.claim("hostile_reflex", "fight", async (signal) => {
    ownedSignal = signal;
    await releasing.promise;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(lower.kind, "claimed");
  await nextTurn();
  let higherStarted = false;
  const escape = async () => {
    higherStarted = true;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  };
  const breath = runner.claim("breath_reflex", "surface", escape);
  assert.equal(breath.kind, "claimed");
  assert.equal((ownedSignal as AbortSignal | null)?.aborted, true);
  assert.equal(higherStarted, false);
  const higher = runner.claim("fire_reflex", "escape", escape);
  assert.equal(higher.kind, "claimed");
  releasing.resolve();
  if (lower.kind === "claimed") await lower.outcome;
  if (breath.kind === "claimed") await breath.outcome;
  if (higher.kind === "claimed") await higher.outcome;
  assert.equal(higherStarted, true);
});

// ── Preemption and resumption of the interrupted request ─────────────────────

test("a resumable task preempted by a reflex runs again once the body is handed back fit", async () => {
  const runs = { count: 0 };
  const task = stubAction(
    async (_request, context) => {
      runs.count += 1;
      if (runs.count === 1) {
        await new Promise<void>((resolve) =>
          context.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw context.signal?.reason;
      }
      return { status: "succeeded" };
    },
    { kind: "resumable_task" },
  );
  const runner = new ActionRunner();

  const outcome = runner.run(task, { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "[HOSTILE_CONTACT] fight response for zombie#7.", async () => ({
    value: "killed",
    continuation: { kind: "resume" as const },
  }));

  assert.equal(claim.kind, "claimed");
  const output = await outcome;
  assert.equal(runs.count, 2);
  assert.deepEqual(output.result, { status: "succeeded" });
  assert.deepEqual(output.interruptions, ["[HOSTILE_CONTACT] fight response for zombie#7."]);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a request executor starts only after admission and is reused with fresh attempt signals", async () => {
  const runner = new ActionRunner();
  let begins = 0;
  const signals: AbortSignal[] = [];
  const entered = deferred();
  const task = defineAction({
    name: "transaction",
    description: "admitted request",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    execution: { kind: "resumable_task" },
    parse: (input: unknown) => {
      const value = stubInputSchema.parse(input);
      if (!value.block_name) throw new Error("required");
      return value;
    },
    begin: () => {
      begins++;
      return async ({ signal }) => {
        signals.push(signal!);
        if (signals.length === 1) {
          entered.resolve();
          await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
          signal!.throwIfAborted();
        }
        return { status: "succeeded" };
      };
    },
  });
  assert.equal((await runner.run(task, {})).result.status, "failed");
  assert.equal(begins, 0);
  const pending = runner.run(task, { block_name: "stone" });
  await entered.promise;
  assert.equal((await runner.run(task, { block_name: "stone" })).result.status, "failed");
  assert.equal(begins, 1);
  runner.claim("reflex", "ate", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  assert.equal((await pending).result.status, "succeeded");
  assert.equal(begins, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
});

/**
 * A preempted task is resumed only when all three agree: the task declared its
 * request safe to repeat, the reflex handed the body back fit, and nobody
 * cancelled during the handoff. Each row withholds one; each ends cancelled
 * after its single run, with no interruption reported as survived.
 */
const unresumed: ReadonlyArray<{
  readonly name: string;
  readonly execution: ActionExecution;
  readonly work: () => Promise<{ value: string; continuation: { kind: "resume" } | { kind: "return"; reason: null } }>;
  readonly cancelDuringHandoff?: boolean;
}> = [
  {
    name: "the reflex withdrew",
    execution: { kind: "resumable_task" },
    work: async () => ({ value: "evaded", continuation: { kind: "return", reason: null } }),
  },
  {
    name: "the reflex threw",
    execution: { kind: "resumable_task" },
    work: async () => {
      throw new Error("session torn down");
    },
  },
  {
    name: "the task did not declare its request safe to repeat",
    execution: { kind: "task" },
    work: async () => ({ value: "killed", continuation: { kind: "resume" } }),
  },
  {
    name: "a control cancellation arrived during the handoff",
    execution: { kind: "resumable_task" },
    work: async () => ({ value: "killed", continuation: { kind: "resume" } }),
    cancelDuringHandoff: true,
  },
];

test("a preempted task stays cancelled unless it may repeat, the reflex resumes it, and nobody cancels", async () => {
  for (const row of unresumed) {
    const runs = { count: 0 };
    const runner = new ActionRunner();
    const outcome = runner.run(preemptible(runs, row.execution), { block_name: "iron_ore" });
    await started(runs, 1);
    const claim = runner.claim("hostile_reflex", "hostile contact", row.work);
    if (row.cancelDuringHandoff) runner.cancelActive("operator stop");

    const output = await outcome;
    await (claim.kind === "claimed" ? claim.outcome.catch(() => undefined) : undefined);
    assert.equal(runs.count, 1, row.name);
    assert.equal(output.result.status, "cancelled", row.name);
    assert.equal(output.interruptions, undefined, row.name);
  }
});

for (const resumeInterrupted of [true, false]) {
  test(`an admitted request stays current through takeover until its ${resumeInterrupted ? "resumed" : "cancelled"} response`, async () => {
    const runner = new ActionRunner();
    const attempts = { count: 0 };
    const action = stubAction(
      async (_request, context) => {
        attempts.count += 1;
        assert.equal(runner.requestContext().requestId, 1236);
        if (attempts.count === 1) {
          await new Promise<void>((_resolve, reject) => {
            context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
          });
        }
        return { status: "succeeded" };
      },
      { kind: "resumable_task" },
    );
    const pending = runner.run(action, { block_name: "stone" }, undefined, 1236);
    await started(attempts, 1);
    const gate = deferred();
    const claim = runner.claim("hostile_reflex", "hostile contact", async () => {
      await gate.promise;
      return {
        value: undefined,
        continuation: resumeInterrupted ? { kind: "resume" as const } : { kind: "return" as const, reason: null },
      };
    });
    assert.equal(claim.kind, "claimed");
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    await untilOwner(runner, "takeover");
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    const information = stubAction(async () => ({ status: "succeeded" }), { kind: "information" });
    await runner.run(information, { block_name: "stone" }, undefined, 1237);
    const busy = await runner.run(action, { block_name: "stone" }, undefined, 1238);
    assert.equal(busy.result.status, "failed");
    assert.ok("error" in busy.result);
    assert.match(busy.result.error, /ACTION_BUSY/);
    await runner.run(action, {}, undefined, 1239);
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    const settledAfter = Date.now();
    gate.resolve();
    const output = await pending;
    assert.equal(output.result.status, resumeInterrupted ? "succeeded" : "cancelled");
    assert.equal(attempts.count, resumeInterrupted ? 2 : 1);
    const context = runner.requestContext();
    assert.equal(context.requestId, null);
    assert.equal(context.preceding?.requestId, 1236);
    assert.ok(context.preceding.completedAtMs >= settledAfter);
    await runner.run(information, { block_name: "stone" }, undefined, 1240);
    assert.deepEqual(runner.requestContext(), context);
  });
}

test("a failed physical claim returns its observed settlement reason with the request", async () => {
  const runner = new ActionRunner();
  const task = stubAction(
    async (_request, context) => {
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      context.signal!.throwIfAborted();
      return { status: "succeeded" };
    },
    { kind: "resumable_task" },
  );
  const pending = runner.run(task, { block_name: "stone" });
  await nextTurn();
  const claim = runner.claim("hostile_reflex", "blaze contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: "Cover route exhausted; health 12.25." },
  }));
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  assert.deepEqual(output.interruptions, ["Cover route exhausted; health 12.25."]);
});

for (const finish of ["complete", "cancel", "disconnect", "refuse"] as const) {
  test(`a fourth takeover waits for its verdict and honors ${finish}`, async () => {
    const runner = new ActionRunner();
    let attempts = 0;
    let begins = 0;
    const task = defineAction({
      name: "measured_task",
      description: "Preserve request progress across successful encounters",
      inputSchema: z.object({}),
      resultSchema: actionResultSchema({ collected: z.number() }),
      formatResult: (result) => result.status,
      execution: { kind: "resumable_task" },
      parse: () => ({}),
      begin: () => {
        begins++;
        let collected = 0;
        return async (context) => {
          attempts++;
          collected++;
          if (attempts === 5) return { status: "succeeded" as const, collected };
          const signal = context.signal;
          assert.ok(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { status: "partial" as const, error: String(signal.reason), collected };
        };
      },
    });
    let returned = false;
    const pending = runner.run(task, {}, undefined, 1311).then((result) => {
      returned = true;
      return result;
    });
    for (let encounter = 1; encounter <= 4; encounter++) {
      await untilOwner(runner, "foreground");
      await nextTurn();
      const held = deferred();
      const claim = runner.claim("hostile_reflex", `contact ${encounter}`, async (signal) => {
        await held.promise;
        return {
          value: null,
          continuation:
            !signal.aborted && !(finish === "refuse" && encounter === 4)
              ? { kind: "resume" as const }
              : { kind: "return" as const, reason: null },
        };
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") throw new Error("Expected claim");
      if (encounter === 4) {
        await untilOwner(runner, "takeover");
        await nextTurn();
        assert.equal(returned, false, "the fourth verdict is still pending");
        assert.equal(runner.requestContext().requestId, 1311);
        if (finish === "cancel") runner.cancelActive("operator stop");
        if (finish === "disconnect") runner.disconnect("connection ended");
      }
      held.resolve();
      await claim.outcome.catch(() => undefined);
    }
    const output = await pending;
    assert.equal(begins, 1);
    assert.equal(attempts, finish === "complete" ? 5 : 4);
    if (finish === "complete") {
      assert.equal(output.result.status, "succeeded");
      assert.ok("collected" in output.result);
      assert.equal(output.result.collected, 5);
      assert.deepEqual(output.interruptions, ["contact 1", "contact 2", "contact 3", "contact 4"]);
    } else if (finish === "disconnect") assert.equal(output.result.status, "failed");
    else {
      assert.equal(output.result.status, "partial");
      assert.ok("collected" in output.result);
      assert.equal(output.result.collected, 4);
    }
  });
}

// ── Higher reflexes and the footing handoff ──────────────────────────────────

test("an admitted footing claim releases navigation before its recovery takes the airborne body", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  const order: string[] = [];
  const navigationReleased = deferred();
  const action = stubAction(async (_request, context) => {
    await navigationReleased.promise;
    order.push("foreground released");
    context.signal!.throwIfAborted();
    return { status: "succeeded" };
  });
  const pending = runner.run(action, { block_name: "stone" });
  await nextTurn();
  let needed = true;
  const recovery = {
    get needed() {
      return needed;
    },
    async recover(): Promise<"landed"> {
      needed = false;
      order.push("recovery owns body");
      return "landed";
    },
  };
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(driver, { activeEngagement: () => null }, recovery, () => {
    assert.equal(runner.status().owner, "yielding", "The handoff must first reserve the next body owner.");
    order.push("navigation interrupted");
    navigationReleased.resolve();
  });
  try {
    bot.emit("physicsTick");
    await nextTurn();
    assert.deepEqual(order, ["navigation interrupted", "foreground released", "recovery owns body"]);
  } finally {
    navigationReleased.resolve();
    await pending;
    await reflex[Symbol.asyncDispose]();
  }
});

test("footing recovery releases navigation while a cancelled lower reflex waits for its handoff", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  const order: string[] = [];
  const navigationReleased = deferred();
  const pending = runner.run(
    stubAction(async (_request, context) => {
      await navigationReleased.promise;
      order.push("foreground released");
      context.signal!.throwIfAborted();
      return { status: "succeeded" };
    }),
    { block_name: "stone" },
  );
  await nextTurn();
  const lower = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
    order.push("cancelled reflex released");
    assert.equal(signal.aborted, true);
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  let needed = true;
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(
    driver,
    { activeEngagement: () => null },
    {
      get needed() {
        return needed;
      },
      async recover(): Promise<"landed"> {
        order.push("recovery owns body");
        needed = false;
        return "landed";
      },
    },
    () => {
      order.push("navigation interrupted");
      navigationReleased.resolve();
    },
  );
  try {
    bot.emit("physicsTick");
    assert.deepEqual(order, ["navigation interrupted"]);
    if (lower.kind === "claimed") await lower.outcome;
    await pending;
    bot.emit("physicsTick");
    await nextTurn();
    assert.deepEqual(order, [
      "navigation interrupted",
      "foreground released",
      "cancelled reflex released",
      "recovery owns body",
    ]);
  } finally {
    navigationReleased.resolve();
    await pending;
    if (lower.kind === "claimed") await lower.outcome;
    await reflex[Symbol.asyncDispose]();
  }
});

for (const resumeInterrupted of [true, false]) {
  test(`a higher reflex preserves the original request until its ${resumeInterrupted ? "resume" : "stop"} verdict`, async () => {
    const runner = new ActionRunner();
    const order: string[] = [];
    const cleanup = deferred();
    let attempts = 0;
    const request = runner.run(
      stubAction(
        async (_request, context) => {
          attempts++;
          if (attempts === 1) {
            await cleanup.promise;
            order.push("foreground released");
            context.signal!.throwIfAborted();
          }
          order.push("foreground resumed");
          return { status: "succeeded" };
        },
        { kind: "resumable_task" },
      ),
      { block_name: "stone" },
    );
    await nextTurn();
    const lower = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
      order.push("lower released");
      signal.throwIfAborted();
      return { value: null, continuation: { kind: "resume" as const } };
    });
    const lowerFinished = lower.kind === "claimed" ? lower.outcome.catch(() => undefined) : Promise.resolve();
    const higher = runner.claim("recover_footing", "unsafe impulse", async () => {
      order.push("recovery owns body");
      return {
        value: null,
        continuation: resumeInterrupted ? { kind: "resume" as const } : { kind: "return" as const, reason: null },
      };
    });
    try {
      assert.equal(higher.kind, "claimed");
      assert.deepEqual(order, []);
      cleanup.resolve();
      await lowerFinished;
      if (higher.kind === "claimed") await higher.outcome;
      const output = await request;
      assert.equal(output.result.status, resumeInterrupted ? "succeeded" : "cancelled");
      assert.equal(attempts, resumeInterrupted ? 2 : 1);
      assert.deepEqual(order, [
        "foreground released",
        "lower released",
        "recovery owns body",
        ...(resumeInterrupted ? ["foreground resumed"] : []),
      ]);
    } finally {
      cleanup.resolve();
      await lowerFinished;
      if (higher.kind === "claimed") await higher.outcome;
      await request;
    }
  });
}

test("operator cancellation during a higher reflex cannot resume the original request", async () => {
  const runner = new ActionRunner();
  const route = deferred();
  const recovery = deferred();
  let recoveryStarted = false;
  let attempts = 0;
  const request = runner.run(
    stubAction(
      async (_request, context) => {
        attempts++;
        if (attempts === 1) {
          await route.promise;
          context.signal!.throwIfAborted();
        }
        return { status: "succeeded" };
      },
      { kind: "resumable_task" },
    ),
    { block_name: "stone" },
  );
  await nextTurn();
  const lower = runner.claim("hostile_reflex", "contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: null },
  }));
  const higher = runner.claim("recover_footing", "impulse", async () => {
    recoveryStarted = true;
    await recovery.promise;
    return { value: null, continuation: { kind: "resume" as const } };
  });
  try {
    assert.equal(higher.kind, "claimed");
    route.resolve();
    if (lower.kind === "claimed") await lower.outcome;
    await nextTurn();
    assert.equal(recoveryStarted, true);
    runner.cancelActive("operator cancellation");
    recovery.resolve();
    if (higher.kind === "claimed") await higher.outcome;
    assert.equal((await request).result.status, "cancelled");
    assert.equal(attempts, 1);
  } finally {
    route.resolve();
    recovery.resolve();
    if (lower.kind === "claimed") await lower.outcome;
    if (higher.kind === "claimed") await higher.outcome;
    await request;
  }
});

test("a refused footing claim cannot release another reflex's navigation", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  const held = deferred();
  const fire = runner.claim("fire_reflex", "leave lava", async () => {
    await held.promise;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  let navigationReleased = false;
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(
    driver,
    { activeEngagement: () => null },
    {
      needed: true,
      async recover() {
        throw new Error("A refused claim must not drive.");
      },
    },
    () => {
      navigationReleased = true;
    },
  );
  try {
    bot.emit("physicsTick");
    assert.equal(navigationReleased, false);
    assert.equal(runner.status().activeAction?.action, "fire_reflex");
  } finally {
    held.resolve();
    if (fire.kind === "claimed") await fire.outcome;
    await reflex[Symbol.asyncDispose]();
  }
});

// ── Disconnect ───────────────────────────────────────────────────────────────

test("disconnect fails an executor that never settles and permanently closes admission", async () => {
  const runner = new ActionRunner();
  const executing = deferred();
  const action = stubAction(async () => {
    executing.resolve();
    return new Promise<never>(() => {});
  });
  const pending = runner.run(action, { block_name: "stone" }, undefined, 1236);
  await executing.promise;
  assert.equal(runner.requestContext().requestId, 1236);
  runner.disconnect("Minecraft connection ended: socketClosed");
  const output = await pending;
  assert.equal(runner.requestContext().requestId, null);
  assert.equal(runner.requestContext().preceding?.requestId, 1236);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /MINECRAFT_DISCONNECTED.*socketClosed/);
  assert.equal(runner.status().busy, false);
  const refused = (await runner.run(action, {})).result;
  assert.equal(refused.status, "failed");
  assert.match("error" in refused ? refused.error : "", /MINECRAFT_DISCONNECTED/);
});

test("disconnect settles an action awaiting a reflex that never returns", async () => {
  const runner = new ActionRunner();
  const runs = { count: 0 };
  const pending = runner.run(preemptible(runs, { kind: "resumable_task" }), { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "hostile contact", () => new Promise<never>(() => {}));
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const ended = assert.rejects(claim.outcome, /MINECRAFT_DISCONNECTED/);
  await untilOwner(runner, "takeover");
  runner.disconnect("socket closed during reflex");
  const output = await pending;
  await ended;
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /MINECRAFT_DISCONNECTED/);
  assert.equal(runs.count, 1);
  assert.equal(runner.status().busy, false);
});

test("disconnect settles a yielding claim and late foreground cleanup cannot reacquire the body", async () => {
  const runner = new ActionRunner();
  const blocked = deferred();
  let entered = false;
  const action = stubAction(
    async () => {
      entered = true;
      await blocked.promise;
      return { status: "succeeded", collected: 1 };
    },
    { kind: "task" },
  );
  const pending = runner.run(action, { block_name: "iron_ore" });
  while (!entered) await Promise.resolve();
  let claimed = false;
  const claim = runner.claim("reflex", "contact", async () => {
    claimed = true;
    return { value: "done", continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const rejected = assert.rejects(claim.outcome, /socket ended/);
  runner.disconnect("socket ended");
  assert.equal((await pending).result.status, "failed");
  await rejected;
  blocked.resolve();
  await nextTurn();
  assert.equal(claimed, false);
  assert.equal(runner.status().owner, "idle");
});

test("disconnect ends the admitted lifetime even when its physical executor never settles", async () => {
  const runner = new ActionRunner();
  let lifetime: AbortSignal | undefined;
  let disposed = 0;
  const action = defineAction({
    name: "unsettled_lifetime",
    description: "A lost connection may leave a physical promise unsettled.",
    inputSchema: z.object({}),
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: () => ({}),
    execution: { kind: "resumable_task" },
    begin: (_request, admitted) => {
      lifetime = admitted;
      admitted.addEventListener(
        "abort",
        () => {
          disposed++;
        },
        { once: true },
      );
      return async () => new Promise<never>(() => {});
    },
  });
  const pending = runner.run(action, {});
  await nextTurn();
  assert.ok(lifetime);
  assert.equal(lifetime.aborted, false);
  runner.disconnect("socket closed");
  assert.equal((await pending).result.status, "failed");
  assert.equal(lifetime.aborted, true);
  assert.equal(disposed, 1);
});
