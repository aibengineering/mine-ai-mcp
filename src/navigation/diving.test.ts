import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { Diving } from "./diving.js";
import { MemoryWorld } from "./world/memory-world.js";
import { createMovementPolicy } from "./movements/policy.js";
import { exactBlockGoal } from "./goals/index.js";

function fixture() {
  const world = new MemoryWorld();
  for (let y = 59; y <= 65; y++) world.load({ x: 0, y, z: 0 }, y === 59 ? { stateId: 1 } : y <= 63
    ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } } : { stateId: 0 });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 61.2, 0.5), metadata: [300], onGround: false },
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    blockAt: (p: Vec3) => {
      const cell = world.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return cell.kind === "loaded" ? { name: cell.traits.liquid ?? (cell.stateId === 0 ? "air" : "stone") } : null;
    },
    setControlState: () => {},
  }) as unknown as Bot;
  return { world, bot };
}

test("a dive declaration and its watcher end on success, cancellation, and exceptions", async () => {
  const { world, bot } = fixture();
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) };
  await assert.rejects(diving.run(options, async () => {
    assert.equal(diving.owned, true);
    assert.ok(diving.backstop()! > 25);
    throw new Error("failed physical route");
  }), /failed physical route/);
  assert.equal(diving.owned, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  const result = await diving.run(options, async (request) => {
    diving.cancel("takeover");
    assert.equal(request.stopSignal?.aborted, true);
    return { status: "stopped", reason: "takeover", elapsedMs: 0 };
  });
  assert.equal(result.status, "stopped");
  assert.equal(diving.active, false);
  assert.equal(diving.backstop(), null);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("planned breathing returns to the original goal after observing full air", async () => {
  const { world, bot } = fixture();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      Reflect.set(bot.entity.metadata, 0, 60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      assert.notEqual(request.goal, goal);
      bot.entity.position.y = 63.5;
      Reflect.set(bot.entity.metadata, 0, 300);
    } else assert.equal(request.goal, goal);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("floating work with dry eyes keeps the existing surface-mining contract", () => {
  const { world, bot } = fixture();
  bot.entity.position.y = 62.5; // The floored head cell is water, but the actual eyes are above it.
  Reflect.set(bot.entity, "metadata", []);
  assert.equal(new Diving(bot, world).beforeWork(400), null);
});

test("quantity completion still returns a mining process to air, while takeover cancels refill without another tick", async () => {
  const { world, bot } = fixture();
  const diving = new Diving(bot, world);
  const quantity = new AbortController();
  let breathing!: () => void;
  const startedBreathing = new Promise<void>((resolve) => { breathing = resolve; });
  bot.setControlState = (control, active) => { if (control === "jump" && active) breathing(); };
  let calls = 0;
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }),
    onArrival: () => ({ kind: "completed" as const }), stopSignal: quantity.signal };
  const pending = diving.run(options, async (request) => {
    calls++;
    if (calls === 1) {
      quantity.abort("quantity collected");
      return { status: "stopped", reason: "quantity collected", elapsedMs: 0 };
    }
    assert.equal(request.stopSignal?.aborted, false, "the process still owes its surface handoff");
    bot.entity.position.y = 63.5;
    Reflect.set(bot.entity.metadata, 0, 200);
    return { status: "completed", elapsedMs: 0 };
  });
  await startedBreathing;
  diving.cancel("connection ended during refill");
  const result = await pending;
  assert.equal(result.status, "stopped");
  assert.ok(result.status === "stopped" && result.reason === "connection ended during refill");
  assert.equal(calls, 2);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});
