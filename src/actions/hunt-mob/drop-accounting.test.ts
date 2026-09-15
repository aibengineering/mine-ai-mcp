import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observeHuntDrops } from "./drop-accounting.js";
import { huntDropSightingSchema } from "./contract.js";

function fixture() {
  const blocks = new Map<string, { name: string }>();
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1 },
    entities: {} as Bot["entities"],
    blockAt: (position: Vec3) => blocks.get(position.floored().toString()) ?? null,
  }) as unknown as Bot;
  const lifetime = new AbortController();
  const item = (id: number, stack: { name: string; count: number } | null) => {
    const state = { stack };
    const entity = {
      id,
      isValid: true,
      position: new Vec3(20, 45, -19),
      getDroppedItem: () => state.stack,
    } as Bot["entity"];
    bot.entities[id] = entity;
    return { entity, state };
  };
  return { bot, lifetime, item, blocks };
}

test("records late item metadata, current location, and unexplained disappearance without inventing a pickup", () => {
  const f = fixture();
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  const drop = f.item(7, null);
  f.bot.emit("entitySpawn", drop.entity);
  assert.deepEqual(read(), []);
  drop.state.stack = { name: "magma_cream", count: 2 };
  f.bot.emit("itemDrop", drop.entity);
  drop.entity.position = new Vec3(22, 44, -19);
  assert.equal(read()[0]!.position.y, 44);
  f.bot.emit("entityGone", drop.entity);
  delete f.bot.entities[7];
  const sighting = huntDropSightingSchema.parse(read()[0]);
  assert.equal(sighting.firstSeen, "during_hunt");
  assert.equal(sighting.state, "no_longer_observed");
  assert.equal(sighting.observedCount, 2);
  assert.equal(sighting.collectedByBot, false);
  assert.deepEqual(sighting.blocks, { atPosition: null, belowPosition: null });
  f.lifetime.abort();
  assert.deepEqual(f.bot.eventNames(), [], "request settlement detaches every listener");
});

test("records a drop moving from air into lava without claiming destruction or pickup", () => {
  const f = fixture();
  f.blocks.set(new Vec3(20, 45, -19).toString(), { name: "air" });
  f.blocks.set(new Vec3(20, 44, -19).toString(), { name: "lava" });
  f.blocks.set(new Vec3(20, 43, -19).toString(), { name: "basalt" });
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  const drop = f.item(7, { name: "magma_cream", count: 1 });
  f.bot.emit("itemDrop", drop.entity);
  assert.deepEqual(read()[0]!.blocks, { atPosition: "air", belowPosition: "lava" });
  drop.entity.position.y = 44.56;
  f.bot.emit("entityMoved", drop.entity);
  // Removal may arrive without readable item metadata; retain the last movement observation.
  drop.state.stack = null;
  f.bot.emit("entityGone", drop.entity);
  delete f.bot.entities[7];
  const sighting = huntDropSightingSchema.parse(read()[0]);
  assert.deepEqual(sighting.blocks, { atPosition: "lava", belowPosition: "basalt" });
  assert.equal(sighting.position.y, 44.56);
  assert.equal(sighting.state, "no_longer_observed");
  assert.equal(sighting.collectedByBot, false);
  assert.equal(sighting.collectedByOther, false);
  f.lifetime.abort();
  assert.deepEqual(f.bot.eventNames(), []);
});

test("a partial collection can leave a loaded remainder; other collectors are distinct", () => {
  const f = fixture();
  const drop = f.item(7, { name: "magma_cream", count: 3 });
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  f.bot.emit("playerCollect", f.bot.entity, drop.entity);
  drop.state.stack = { name: "magma_cream", count: 2 };
  assert.deepEqual(
    read().map((s) => [s.state, s.observedCount, s.collectedByBot]),
    [["loaded", 2, true]],
  );
  f.bot.emit("playerCollect", { id: 2 } as Bot["entity"], drop.entity);
  delete f.bot.entities[7];
  assert.equal(read()[0]!.collectedByOther, true);
  assert.equal(read()[0]!.firstSeen, "already_loaded");
  f.lifetime.abort();
});

test("observations survive physical attempt cancellation but end with the admitted request", () => {
  const f = fixture();
  const attempt = new AbortController();
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  attempt.abort("hostile reflex took over");
  const drop = f.item(8, { name: "magma_cream", count: 1 });
  f.bot.emit("itemDrop", drop.entity);
  assert.equal(read()[0]!.state, "loaded");
  assert.equal(f.bot.listenerCount("itemDrop"), 1);
  f.lifetime.abort();
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
});
