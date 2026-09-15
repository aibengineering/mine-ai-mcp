import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { temporaryBotData } from "../test-support/bot-data.js";
import { observeBotStatus } from "./bot-status.js";

function fixture() {
  const inventory = Object.assign(new EventEmitter(), {
    inventoryStart: 9,
    slots: [] as Array<{ slot: number; name: string; count: number } | null>,
    items() { return this.slots.filter(item => item && item.slot >= 9 && item.slot <= 44); },
  });
  const bot = Object.assign(new EventEmitter(), {
    username: "StreamBot", inventory, currentWindow: null as (EventEmitter & {
      inventoryStart: number; items(): Array<{ slot: number; name: string; count: number }>;
    }) | null,
    quickBarSlot: 0, game: { dimension: "overworld" },
  });
  return { bot, inventory };
}

test("SQL follows pickups, held equipment, open-container transfers and empty inventory without tool calls", async t => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, inventory } = fixture();
  const stop = observeBotStatus(bot as unknown as Bot, data);
  t.after(stop);
  inventory.slots[36] = { slot: 36, name: "oak_log", count: 3 };
  inventory.slots[5] = { slot: 5, name: "iron_helmet", count: 1 };
  inventory.emit("updateSlot");
  await delay(300);
  const rows = () => data.read("SELECT slot, item_name, count, held FROM bot_inventory ORDER BY slot");
  assert.deepEqual(rows(), [
    { slot: 5, item_name: "iron_helmet", count: 1, held: 0 },
    { slot: 36, item_name: "oak_log", count: 3, held: 1 },
  ]);
  const chest = Object.assign(new EventEmitter(), {
    inventoryStart: 27,
    items: () => [{ slot: 54, name: "diamond", count: 2 }],
  });
  bot.currentWindow = chest;
  bot.emit("windowOpen", chest);
  await delay(300);
  assert.deepEqual(rows()[1], { slot: 36, item_name: "diamond", count: 2, held: 1 });
  chest.items = () => [{ slot: 54, name: "diamond", count: 1 }];
  chest.emit("updateSlot");
  bot.quickBarSlot = 1;
  bot.emit("heldItemChanged");
  await delay(300);
  assert.deepEqual(rows()[1], { slot: 36, item_name: "diamond", count: 1, held: 0 });
  bot.currentWindow = null;
  inventory.slots = [];
  bot.emit("windowClose", chest);
  bot.emit("respawn");
  await delay(300);
  assert.deepEqual(rows(), []);
  assert.equal(chest.listenerCount("updateSlot"), 0);
  assert.equal(data.read("SELECT bot_id FROM bot_status")[0]?.bot_id, "StreamBot");
});

test("heartbeat refreshes idle status, and disconnect cancels queued work before SQL closes", async t => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, inventory } = fixture();
  const stop = observeBotStatus(bot as unknown as Bot, data);
  await delay(300);
  const first = data.read("SELECT updated_at FROM bot_status")[0]?.updated_at;
  await delay(1_050);
  assert.notEqual(data.read("SELECT updated_at FROM bot_status")[0]?.updated_at, first);
  inventory.emit("updateSlot");
  bot.emit("end");
  stop();
  stop();
  assert.equal(inventory.listenerCount("updateSlot"), 0);
  assert.deepEqual(bot.eventNames(), []);
  data.close();
  await delay(300);
});
