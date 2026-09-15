import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { snapshotBotStatus, updateBotStatus } from "./bot-status.js";
import { temporaryBotData } from "../test-support/bot-data.js";

test("an open furnace supplies live carried slots in player-inventory coordinates", () => {
  const fuel = { slot: 5, name: "birch_planks", count: 11 };
  const sword = { slot: 32, name: "stone_sword", count: 1, maxDurability: 131, durabilityUsed: 130 };
  const bot = {
    quickBarSlot: 2,
    inventory: {
      inventoryStart: 9,
      items: () => [{ slot: 40, name: "beef", count: 10 }],
      slots: { 5: { name: "iron_helmet", count: 1 } },
    },
    currentWindow: { inventoryStart: 3, items: () => [fuel, sword] },
  } as unknown as Bot;

  assert.deepEqual(snapshotBotStatus(bot).inventory, [
    { slot: 5, location: "head", name: "iron_helmet", count: 1, held: false, durability: null },
    { slot: 11, location: "main", name: "birch_planks", count: 11, held: false, durability: null },
    {
      slot: 38,
      location: "hotbar",
      name: "stone_sword",
      count: 1,
      held: true,
      durability: { remaining: 1, maximum: 131 },
    },
  ]);
  assert.equal(fuel.slot, 5);
  assert.equal(sword.slot, 32);
});

test("captures and persists the bot's queryable live status", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const bot = {
    username: "bot1",
    game: { dimension: "minecraft:overworld" },
    entity: {
      position: { x: 100.5, y: 64, z: -200.25 },
      yaw: 1.57,
      pitch: 0,
    },
    health: 18.5,
    food: 20,
  } as unknown as Bot;

  updateBotStatus(data, { ...snapshotBotStatus(bot), updatedAt: "2026-08-21T00:00:00.000Z" });

  assert.deepEqual(data.read("SELECT bot_id, dimension, x, y, z, chunk_x, chunk_z, health, food FROM bot_status"), [
    {
      bot_id: "bot1",
      dimension: "minecraft:overworld",
      x: 100.5,
      y: 64,
      z: -200.25,
      chunk_x: 6,
      chunk_z: -13,
      health: 18.5,
      food: 20,
    },
  ]);
});
