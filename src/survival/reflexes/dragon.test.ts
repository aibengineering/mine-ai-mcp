import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { ReflexDriver } from "../control/driver.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";
import { attachDragonReflex } from "./dragon.js";

test("idle dragon defense claims one body, leaves active combat alone, and awaits cancellation cleanup", async () => {
  const bot = Object.assign(new EventEmitter(), {
    username: "DragonReflex",
    health: 20,
    entities: {},
    entity: { position: new Vec3(0, 64, 0) },
  }) as unknown as Bot;
  const runner = new ActionRunner();
  const driver = new ReflexDriver(bot, runner);
  let active: number | null = 42,
    calls = 0,
    released = false;
  const reflex = attachDragonReflex(bot, driver, {
    policy: new SurvivalPolicyState(bot),
    activeEngagement: () => (active === null ? null : { kind: "mob", targetId: active }),
    endDanger: () => true,
    async runEnd(request, signal) {
      calls++;
      assert.equal(request.kind, "evade");
      assert.equal(runner.status().owner, "takeover");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      released = true;
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  bot.emit("physicsTick");
  assert.equal(calls, 0);
  active = null;
  bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  bot.emit("physicsTick");
  assert.equal(calls, 1);
  await reflex[Symbol.asyncDispose]();
  await driver[Symbol.asyncDispose]();
  assert.equal(released, true);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(runner.status().owner, "idle");
});

test("prohibited dragon retreat stands down and a permitted policy revision re-arms it", async () => {
  const bot = Object.assign(new EventEmitter(), {
    username: "DragonPolicy",
    health: 20,
    entities: {},
    entity: { position: new Vec3(0, 64, 0) },
  }) as unknown as Bot;
  const runner = new ActionRunner();
  const driver = new ReflexDriver(bot, runner);
  const policy = new SurvivalPolicyState(bot);
  let calls = 0;
  const reflex = attachDragonReflex(bot, driver, {
    policy,
    activeEngagement: () => null,
    endDanger: () => true,
    async runEnd(_request, signal) {
      calls++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  try {
    await policy.edit({
      operation: "set",
      expected_revision: policy.snapshot().revision,
      changes: { combat: { retreat: false } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    bot.emit("physicsTick");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(runner.status().owner, "idle");
    assert.deepEqual(driver.snapshot()[0]?.decision, {
      kind: "stand_down",
      candidates: [{ response: "evade", excluded: { kind: "prohibited", field: "retreat" } }],
    });
    await policy.edit({ operation: "reset", expected_revision: policy.snapshot().revision, reason: "test" });
    bot.emit("physicsTick");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(runner.status().owner, "takeover");
  } finally {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
});
