import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Bot } from "mineflayer";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { prepareScenarioBot } from "./scenario-bot.ts";

function fixture() {
  const bot = Object.assign(new EventEmitter(), {
    username: "Actor",
    _client: new EventEmitter(),
    tool: { equipForBlock: async () => {} },
    inventory: Object.assign(new EventEmitter(), { items: () => [] }),
    registry: { itemsByName: {} },
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0, 0, 0), onGround: true },
    physicsEnabled: true,
    food: 0,
    health: 20,
    blockAt: () => ({}),
  }) as unknown as Bot;
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const arranged = Promise.withResolvers<void>();
  const session = {
    scenario: scenarioDefinitionSchema.parse({
      players: [{ name: "Actor", pos: [0, 0, 0] }],
      goal: { kind: "completion" },
    }),
    signal: controller.signal,
    ready: () => ready.resolve(),
    arranged: arranged.promise,
  };
  return { bot, controller, ready, arranged, session };
}

test("readiness observes vitals, accepts zero food, and ends physics control before execution", async () => {
  const { bot, session, ready, arranged } = fixture();
  bot.blockAt = () => null;
  const prepared = prepareScenarioBot(bot, session);
  bot.emit("spawn");
  await setImmediate();
  assert.equal(bot.listenerCount("forcedMove"), 0, "arrangement must wait for an actual health packet");
  bot.emit("health");
  await ready.promise;
  bot.emit("forcedMove");
  arranged.resolve();
  await setImmediate();
  assert.equal(bot.physicsEnabled, false, "keep physics paused while terrain is absent");

  bot.blockAt = () => ({}) as NonNullable<ReturnType<Bot["blockAt"]>>;
  await delay(60); // Let the 50 ms column observation see the loaded terrain.
  assert.equal(bot.physicsEnabled, true);
  for (let tick = 0; tick < 10; tick++) {
    bot.emit("physicsTick");
    await setImmediate();
  }
  await prepared;
  for (const event of ["spawn", "health", "forcedMove", "physicsTick"] as const) {
    assert.equal(bot.listenerCount(event), 0, `${event} setup listener leaked`);
  }
  bot.emit("spawn");
  assert.equal(bot.physicsEnabled, true, "later spawns must not pause execution");
});

test("cancelling before spawn removes both startup waits and restores physics", async () => {
  const { bot, session, controller } = fixture();
  const prepared = prepareScenarioBot(bot, session);
  const stopped = new Error("stop before spawn");
  controller.abort(stopped);
  await assert.rejects(prepared, (cause) => cause === stopped);
  assert.equal(bot.physicsEnabled, true);
  for (const event of ["spawn", "health", "error"] as const) assert.equal(bot.listenerCount(event), 0);
});

test("cancellation interrupts both terrain and landing waits without another physics tick", async () => {
  for (const phase of ["terrain", "landing"]) {
    const { bot, session, ready, arranged, controller } = fixture();
    if (phase === "terrain") bot.blockAt = () => null;
    bot.entity.onGround = false;
    const prepared = prepareScenarioBot(bot, session);
    bot.emit("spawn");
    bot.emit("health");
    await ready.promise;
    bot.emit("forcedMove");
    arranged.resolve();
    await setImmediate();
    assert.equal(bot.physicsEnabled, phase === "landing");
    controller.abort(new Error(`stop during ${phase}`));
    await assert.rejects(prepared);
    assert.equal(bot.physicsEnabled, true);
    assert.equal(bot.listenerCount("physicsTick"), 0);
    assert.equal(bot.listenerCount("forcedMove"), 0);
  }
});
