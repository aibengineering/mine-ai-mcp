import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { botFixture } from "../../test-support/bot.js";
import { recoverEyeDrop } from "./recover-eye.js";

function fixture() {
  const eyes = { name: "ender_eye", count: 15, stackSize: 64 };
  const bot = botFixture({ position: { x: 0, y: 64, z: 0 }, items: [eyes] });
  createMovements(bot); // Install the runtime inventory observer before measuring pickup cleanup.
  const inventoryListeners = bot.inventory.listenerCount("updateSlot");
  const item = { id: 90, position: new Vec3(12, 64, 0), getDroppedItem: () => ({ name: "ender_eye" }) };
  const addDrop = () => { bot.entities[item.id] = item as never; bot.emit("itemDrop", item as never); };
  const collect = () => { eyes.count++; delete bot.entities[item.id]; bot.inventory.emit("updateSlot", 36, null, null); };
  return { bot, item, addDrop, collect, inventoryListeners, count: () => eyes.count };
}
const endpoint = new Vec3(12, 72, 0);
/** Settle windows short enough that a test can let them lapse for real. */
const settleMs = { drop: 20, itemGone: 20, pickup: 20 };

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
  // The drop's metadata may still arrive; recovery gives it the drop window before leaving.
  const recovery = recoverEyeDrop(f.bot, nav, endpoint, undefined, settleMs);
  assert.equal(await recovery, undefined);
  assert.equal(f.count(), 15);
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
});

test("unreachable eye recovery returns without claiming inventory gain", async () => {
  const f = fixture(); f.addDrop();
  const nav = { navigate: async () => ({ status: "stopped", reason: "no safe path", elapsedMs: 1 }) } as unknown as NavigationRuntime;
  const recovery = await recoverEyeDrop(f.bot, nav, endpoint, undefined, settleMs);
  assert.equal(recovery?.kind, "not_collected");
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
