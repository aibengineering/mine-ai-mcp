import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { useItemAt } from "./item-use.js";
import type { InventoryItem } from "./placement.js";

/** A bot whose world and hand change `ticksUntilEffect` ticks after the item is used. */
function usingBot(ticksUntilEffect: number, stackedBuckets = false) {
  const target = new Vec3(3, 63, 0);
  const calls: string[] = [];
  let ticksSinceUse = -1;
  const effected = () => ticksSinceUse >= ticksUntilEffect;
  const bot = {
    usingHeldItem: false,
    get heldItem() {
      return { name: effected() && !stackedBuckets ? "water_bucket" : "bucket" };
    },
    inventory: {
      items: () => [
        { name: "bucket", count: effected() ? 1 : 2 },
        { name: "water_bucket", count: effected() ? 1 : 0 },
      ],
    },
    equip: async (item: InventoryItem) => {
      calls.push(`equip ${item.name}`);
    },
    lookAt: async (point: Vec3, force: boolean) => {
      calls.push(`look ${point.x},${point.y},${point.z} force=${force}`);
    },
    activateItem: () => {
      calls.push("use");
      ticksSinceUse = 0;
      bot.usingHeldItem = true;
    },
    deactivateItem: () => {
      calls.push("release");
      bot.usingHeldItem = false;
    },
    waitForTicks: async () => {
      if (ticksSinceUse >= 0) ticksSinceUse += 1;
    },
    blockAt: (position: Vec3) =>
      position.equals(target) ? { name: effected() ? "air" : "water", position } : { name: "stone", position },
  } as unknown as Bot & { usingHeldItem: boolean };
  return { bot, calls, target };
}

test("equips, looks with force, uses, and confirms the cell and the hand", async () => {
  const { bot, calls, target } = usingBot(3);
  const result = await useItemAt(bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
    expectedHeldItem: "water_bucket",
  });

  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(calls, ["equip bucket", "look 3.5,63.5,0.5 force=true", "use", "release"]);
});

test("an unconfirmed use reports what it observed, whichever evidence it was waiting for", async () => {
  const world = usingBot(1_000);
  const unchanged = await useItemAt(world.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    expectedHeldItem: "water_bucket",
    timeoutTicks: 5,
  });

  assert.equal(unchanged.kind, "failed");
  if (unchanged.kind !== "failed") return;
  assert.match(unchanged.error, /not confirmed within 5 ticks/);
  assert.match(unchanged.error, /\(3, 63, 0\)=water, hand=bucket/);
  assert.equal(world.bot.usingHeldItem, false, "an unconfirmed use still releases the item");

  // A water bucket already in inventory is not evidence of a new scoop.
  const carried = usingBot(1_000);
  Object.defineProperty(carried.bot, "inventory", { value: { items: () => [{ name: "water_bucket", count: 1 }] } });
  const noGain = await useItemAt(carried.bot, {
    item: { name: "bucket", count: 2 } as InventoryItem,
    lookAt: { x: 3.5, y: 63.9, z: 0.5 },
    expectedInventoryGain: { item: "water_bucket", count: 1 },
    timeoutTicks: 5,
  });

  assert.equal(noGain.kind, "failed");
  if (noGain.kind !== "failed") return;
  assert.match(noGain.error, /water_bucket inventory=1, expected at least 2/);
});

test("a stacked bucket fill is confirmed by a new inventory item while the empty bucket stays held", async () => {
  const { bot } = usingBot(2, true);
  const result = await useItemAt(bot, {
    item: { name: "bucket", count: 2 } as InventoryItem,
    lookAt: { x: 3.5, y: 63.9, z: 0.5 },
    expectedInventoryGain: { item: "water_bucket", count: 1 },
  });
  assert.deepEqual(result, { kind: "used" });
  assert.equal(bot.heldItem?.name, "bucket");
});

test("an item that acts on a block is used on the named face", async () => {
  const { bot, calls, target } = usingBot(1);
  const activated: string[] = [];
  Object.assign(bot, {
    activateBlock: async (block: { name: string }, face: Vec3) => {
      activated.push(`${block.name} ${face.x},${face.y},${face.z}`);
      bot.activateItem();
    },
  });
  const result = await useItemAt(bot, {
    item: { name: "flint_and_steel" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.01, z: 0.5 },
    on: { block: { name: "obsidian" } as never, face: { x: 0, y: 1, z: 0 } },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
  });
  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(activated, ["obsidian 0,1,0"]);
  assert.equal(calls.filter((call) => call === "use").length, 1);
});

test("a hand that need not change is not waited on", async () => {
  const { bot, target } = usingBot(2);
  const result = await useItemAt(bot, {
    item: { name: "flint_and_steel" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
  });
  assert.deepEqual(result, { kind: "used" });
});
