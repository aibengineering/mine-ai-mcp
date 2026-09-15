import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { recoverEyeDrop } from "./recover-eye.js";

function fixture() {
  let count = 15;
  const bot = Object.assign(new EventEmitter(), {
    registry: minecraftData("1.21.4"),
    entity: { position: new Vec3(0, 64, 0), effects: {} },
    entities: {},
    inventory: Object.assign(new EventEmitter(), {
      items: () => [{ name: "ender_eye", count, stackSize: 64 }],
      emptySlotCount: () => 35,
    }),
  }) as unknown as Bot;
  createMovements(bot); // Install the runtime inventory observer before measuring pickup cleanup.
  const inventoryListeners = bot.inventory.listenerCount("updateSlot");
  const item = { id: 90, position: new Vec3(12, 64, 0), getDroppedItem: () => ({ name: "ender_eye" }) };
  const addDrop = () => { bot.entities[item.id] = item as never; bot.emit("itemDrop", item as never); };
  const collect = () => { count++; delete bot.entities[item.id]; bot.inventory.emit("updateSlot", 36, null, null); };
  return { bot, item, addDrop, collect, inventoryListeners, count: () => count };
}
const endpoint = new Vec3(12, 72, 0);

test("recovers delayed native item metadata and requires inventory gain", async () => {
  const f = fixture();
  let routes = 0;
  const nav = { navigate: async () => {
    routes++; f.collect(); return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  const work = recoverEyeDrop(f.bot, nav, endpoint);
  f.addDrop();
  assert.deepEqual(await work, { kind: "collected" });
  assert.equal(routes, 1);
  assert.equal(f.count(), 16);
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.inventoryListeners);
});

test("a shattered eye or unrelated distant drop does not start a route", async () => {
  const f = fixture();
  f.item.position = new Vec3(28, 64, 0); f.addDrop();
  const nav = { navigate: async () => { assert.fail("No matching drop exists."); } } as unknown as NavigationRuntime;
  assert.equal(await recoverEyeDrop(f.bot, nav, endpoint), undefined);
  assert.equal(f.count(), 15);
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
});

test("unreachable eye recovery returns without claiming inventory gain", async () => {
  const f = fixture(); f.addDrop();
  const nav = { navigate: async () => ({ status: "stopped", reason: "no safe path", elapsedMs: 1 }) } as unknown as NavigationRuntime;
  assert.equal((await recoverEyeDrop(f.bot, nav, endpoint))?.kind, "not_collected");
  assert.equal(f.count(), 15);
});

test("cancellation releases pickup ownership and a later attempt can recover the same drop", async () => {
  const f = fixture(); f.addDrop(); const stop = new AbortController();
  const nav = { navigate: async ({ signal }: { signal: AbortSignal }) => {
    stop.abort(new Error("reflex takeover")); signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  await assert.rejects(recoverEyeDrop(f.bot, nav, endpoint, stop.signal), /reflex takeover/);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.inventoryListeners);
  assert.equal(f.count(), 15);
  const resumed = { navigate: async () => { f.collect(); return { status: "completed", elapsedMs: 1 }; } } as unknown as NavigationRuntime;
  assert.equal((await recoverEyeDrop(f.bot, resumed, endpoint))?.kind, "collected");
  assert.equal(f.count(), 16);
});
