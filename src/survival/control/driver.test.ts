import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BodyAbort } from "../../session/abort.js";
import { ActionRunner } from "../../session/action-runner.js";
import { type SurvivalTransition } from "./contract.js";
import { ReflexDriver } from "./driver.js";

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const botFixture = () =>
  Object.assign(new EventEmitter(), { health: 20, game: { dimension: "overworld" } }) as unknown as Bot;

test("a failed moving response answers its final arrangement before another tick", async () => {
  const bot = botFixture();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  let cell = "A",
    attempts = 0;
  driver.register({
    name: "hostile_reflex",
    sense: () => ({ kind: "observed", danger: true, evidence: true }),
    decide: () => ({ kind: "respond", response: true, name: "evade", reason: "Observed aggression." }),
    facts: () => ({ capability: "evade", response: "evade", scope: cell, facts: () => null, permissions: () => null }),
    act: async () => {
      attempts++;
      cell = "B";
      return "exhausted";
    },
    failure: () => ({ kind: "exhausted", why: "The attacker kept pace." }),
    continuation: () => ({ kind: "return", reason: "Escape exhausted." }),
    describe: () => null,
  });
  bot.emit("physicsTick");
  await settled();
  for (let tick = 0; tick < 100; tick++) bot.emit("physicsTick");
  assert.equal(attempts, 1);
  assert.equal(driver.answered.snapshot()[0]?.scope, "B");
});

test("an execution exception is answered once and only declared premises rearm it", async () => {
  const bot = botFixture();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  let terrain = 1,
    unrelated = 1,
    attempts = 0;
  driver.register({
    name: "fire_reflex",
    sense: () => ({ kind: "observed", danger: true, evidence: { burning: true } }),
    decide: () => ({ kind: "respond", response: true, name: "escape", reason: "Burning in place." }),
    decisionFacts: () => ({ terrain, unrelated }),
    facts: () => ({
      capability: "fire",
      response: "escape",
      scope: "cell:A",
      facts: () => ({ terrain }),
      permissions: () => null,
    }),
    act: async () => {
      attempts++;
      throw new Error("Native movement rejected");
    },
    failure: () => null,
    continuation: () => ({ kind: "resume" }),
    describe: () => null,
  });
  bot.emit("physicsTick");
  await settled();
  unrelated++;
  for (let tick = 0; tick < 100; tick++) bot.emit("physicsTick");
  assert.equal(attempts, 1);
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "execution_failed");
  assert.equal(events.filter((event) => event.kind === "outcome").length, 1);
  assert.equal(events.filter((event) => event.kind === "decision").length, 2, "respond then stand down once");
  terrain++;
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts, 2);
  assert.equal(driver.answered.snapshot().length, 1);
});

for (const cause of ["policy", "death"] as const)
  test(`${cause} interruption is not a failed physical attempt`, async () => {
    const bot = botFixture();
    await using driver = new ReflexDriver(bot, new ActionRunner());
    driver.register({
      name: "fire_reflex",
      sense: () => ({ kind: "observed", danger: true, evidence: true }),
      decide: () => ({ kind: "respond", response: true, name: "escape", reason: "Fire." }),
      facts: () => ({ capability: "fire", response: "escape", scope: "A", facts: () => null, permissions: () => null }),
      act: async (_response, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
      failure: () => ({ kind: "failed", why: "must never be recorded for cancellation" }),
      continuation: () => ({ kind: "resume" }),
      describe: () => null,
    });
    bot.emit("physicsTick");
    await settled();
    if (cause === "death") {
      bot.health = 0;
      bot.emit("death");
    } else
      await driver.cancel("fire_reflex", new BodyAbort({ kind: "policy_changed", revision: "next" }, "Policy changed"));
    await settled();
    assert.deepEqual(driver.answered.snapshot(), []);
    assert.equal(driver.snapshot()[0]?.response, null);
    assert.equal(driver.snapshot()[0]?.stale, cause === "death");
  });
