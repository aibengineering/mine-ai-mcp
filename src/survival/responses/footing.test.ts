import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { FootingRecovery } from "./footing.js";

function fixture(wide = false) {
  const world = new MemoryWorld();
  for (let x = -3; x <= 5; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 46; y <= 49; y++) world.load({ x, y, z }, { stateId: y === 46 && (wide || x === 0) ? 1 : 0 });
  const entity = { id: 1, position: new Vec3(0.8, 47, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 };
  const controls = new Map<string, boolean>();
  const events = Object.assign(new EventEmitter(), {
    entity,
    health: 20,
    _client: new EventEmitter(),
    inventory: { items: () => [] },
    blockAt: () => null,
    deactivateItem: () => {},
    setControlState: (name: string, value: boolean) => controls.set(name, value),
    clearControlStates: () => controls.clear(),
    waitForTicks: async () => {
      entity.position.y = 46.9;
      entity.onGround = false;
      events.emit("physicsTick");
    },
  });
  const impulse = (entityId = 1) =>
    events._client.emit("entity_velocity", { entityId, velocity: { x: 2125, y: 2201, z: 0 } });
  return { world, bot: events as unknown as Bot, events, entity, controls, impulse };
}

test("an edge alone, another entity's impulse, and an impulse over wide safe ground all leave movement alone", () => {
  for (const row of [
    { name: "standing on an edge, with someone else's impulse", wide: false, entityId: 2 },
    { name: "a native impulse over wide safe ground", wide: true, entityId: 1 },
  ]) {
    const fixtureBot = fixture(row.wide);
    using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
    fixtureBot.events.emit("physicsTick");
    fixtureBot.impulse(row.entityId);
    assert.equal(recovery.needed, false, row.name);
    assert.equal(fixtureBot.controls.size, 0, row.name);
  }
});

test("an idle edge hit retains the departure support after the bot becomes airborne", () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  fixtureBot.entity.onGround = false;
  fixtureBot.entity.position.x = 1.2;
  fixtureBot.events.emit("physicsTick");
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
  assert.equal(fixtureBot.controls.size, 0, "observation never drives before a body owner calls recover");
});

test("missing catching geometry reports failure and releases movement instead of claiming a landing", async () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  assert.equal(await recovery.recover(new AbortController().signal), "failed");
  assert.equal(recovery.snapshot()?.phase, "failed");
  assert.equal(recovery.active, false);
  assert.equal(fixtureBot.controls.size, 0);
});

test("an observed lower terrace preserves protection and resumes only after actual landing", async () => {
  const f = fixture();
  f.world.load({ x: 1, y: 45, z: 0 }, { stateId: 1 });
  f.world.load({ x: 1, y: 44, z: 0 }, { stateId: 1 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.entity.position.x = 1.5;
  f.entity.position.y = 51;
  f.events.emit("physicsTick");
  let ticks = 0;
  let protection = 0;
  f.bot.deactivateItem = () => assert.fail("landing must not reset its continuing combat owner's shield readiness");
  f.bot.waitForTicks = async () => {
    ticks++;
    f.entity.position.y = ticks === 1 ? 46.9 : 46;
    f.entity.onGround = ticks > 1;
    f.events.emit("physicsTick");
  };
  assert.equal(await recovery.recover(new AbortController().signal, async () => { protection++; }), "landed");
  assert.ok(protection >= 2);
  assert.equal(ticks, 2, "a predicted landing alone must not resume the request");
  assert.equal(f.controls.size, 0);
});

test("a blast-broken floor can steer onto the adjacent lower cell before releasing the request", async () => {
  const f = fixture();
  for (let y = 44; y <= 46; y++) f.world.load({ x: 1, y, z: 0 }, { stateId: y === 45 ? 1 : 0 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.world.load({ x: 0, y: 46, z: 0 }, { stateId: 0 });
  f.entity.position = new Vec3(0.85, 46.9, 0.5);
  f.entity.velocity = new Vec3(0.04, -0.23, 0);
  f.entity.onGround = false;
  let ticks = 0;
  f.bot.waitForTicks = async () => {
    ticks++;
    if (ticks === 2) {
      assert.equal(recovery.snapshot()?.phase, "steering", "the projected edge is not a terminal failure");
      f.entity.position = new Vec3(1.5, 46, 0.5);
      f.entity.velocity = new Vec3(0, 0, 0);
      f.entity.onGround = true;
    }
    f.events.emit("physicsTick");
  };
  assert.equal(await recovery.recover(new AbortController().signal), "landed");
  assert.equal(ticks, 2);
});

test("a grounded body overlapping lava retains its last safe scaffold for the next impulse", () => {
  const fixtureBot = fixture();
  fixtureBot.entity.position.x = 0.5;
  fixtureBot.world.load({ x: 1, y: 46, z: 0 }, { stateId: 0, traits: { liquid: "lava", damaging: true } });
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.entity.position.x = 0.95;
  fixtureBot.events.emit("physicsTick");
  fixtureBot.impulse();
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
});

test("death interrupts recovery and disposal removes its observation listeners", async () => {
  const fixtureBot = fixture();
  const recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.bot.waitForTicks = async () => {
    fixtureBot.events.emit("death");
  };
  fixtureBot.impulse();
  await assert.rejects(recovery.recover(new AbortController().signal));
  assert.equal(recovery.snapshot()?.phase, "cancelled");
  assert.equal(recovery.active, false);
  assert.equal(fixtureBot.controls.size, 0);
  recovery[Symbol.dispose]();
  assert.equal(fixtureBot.events.listenerCount("physicsTick"), 0);
  assert.equal(fixtureBot.events._client.listenerCount("entity_velocity"), 0);
});
