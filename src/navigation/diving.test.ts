import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { Diving } from "./diving.js";
import { DIVE_BACKSTOP_TICKS } from "./world/swimming.js";
import { FULL_AIR_TICKS } from "../world/air-supply.js";
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

// A 1-wide pocket of *flowing* water over a solid floor, with a solid lid above the head: the shape
// run10 was sealed in. Every cell is loaded by hand, and `liquidSource: false` models water at a
// level other than 0 (falling or flowing), which `openWaterSurface` refuses to follow.
function floodedPocket() {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 60, z: 0 }, { stateId: 1 }); // floor under the feet
  for (const y of [61, 62]) world.load({ x: 0, y, z: 0 },
    { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: false } });
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 1 }); // solid lid above the head
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

test("a body standing in a flooded pocket may dig its own way out", () => {
  // Live run10: sealed in a pocket of flowing water (level != 0, so no source corridor) with every
  // wall solid. Refusing the one escape deadlocked the bot, so a standing body may work while the
  // dig fits the air it has; a long dig still waits for a proper dive.
  const { world, bot } = floodedPocket();
  const diving = new Diving(bot, world);
  assert.equal(diving.beforeWork(40), null);
  assert.match(diving.beforeWork(400) ?? "", /breath is too short/);
});

test("a floating body with no corridor is still refused", () => {
  const { world, bot } = floodedPocket();
  world.load({ x: 0, y: 60, z: 0 }, { stateId: 0 }); // no floor: treading water, not standing
  assert.match(new Diving(bot, world).beforeWork(40) ?? "", /Underwater stance unavailable/);
});

/** Drain the column that admitted the dive to flowing water, so no ascent corridor remains. */
function closeTheCorridor(world: MemoryWorld) {
  for (const y of [61, 62, 63]) world.load({ x: 0, y, z: 0 },
    { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: false } });
}

test("a full breath asks for no rescue when the corridor closes", async () => {
  // Live run15: the bot crossed a pond of seagrass -- whose cells are not source water, so
  // `openWaterSurface` finds no column -- and `backstop()` answered 300 against 300 ticks of air.
  // The reflex's owned-dive continuation then handed the running action back without `surface()`
  // ever moving, so every action in that water came back cancelled: 157 in a row, no progress.
  const { world, bot } = fixture();
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) };
  await assert.rejects(diving.run(options, async () => {
    assert.equal(diving.owned, true);
    assert.ok(diving.backstop()! > DIVE_BACKSTOP_TICKS);
    closeTheCorridor(world);
    assert.equal(diving.backstop(), null);
    Reflect.set(bot.entity, "metadata", [200]);
    assert.equal(diving.backstop(), FULL_AIR_TICKS); // with air actually spent the rescue is due
    throw new Error("probe");
  }), /probe/);
  assert.equal(diving.owned, false);
});

test("a body standing where the corridor closed is never taken over", async () => {
  // The run10 posture, once more: `openWaterSurface` trusts source water alone, so a supported
  // body in a pocket it cannot read is standing -- not diving -- and the ordinary breath
  // threshold governs it, whatever air is left.
  const { world, bot } = fixture();
  world.load({ x: 0, y: 60, z: 0 }, { stateId: 1 }); // solid floor under the feet
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) };
  await assert.rejects(diving.run(options, async () => {
    assert.equal(diving.owned, true);
    closeTheCorridor(world);
    Reflect.set(bot.entity, "metadata", [120]);
    assert.equal(diving.backstop(), null);
    throw new Error("probe");
  }), /probe/);
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
