import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { botFixture } from "../test-support/bot.js";
import { SqlBotData, readNotificationSummary } from "../bot-data/index.js";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { observeEquipmentEvents } from "./equipment-events.js";

function fixture() {
  const bot = botFixture();
  Object.assign(bot, { _client: new EventEmitter() });
  bot.quickBarSlot = 0;
  const data = SqlBotData.create({ storage: { kind: "temporary" },
    identity: { worldId: "equipment-events", scope: { kind: "bot", botId: bot.username } } });
  const put = (slot: number, used: number | null, name = "shield") => {
    bot.inventory.slots[slot] = used === null ? null : { name, count: 1, maxDurability: 100, durabilityUsed: used } as never;
    bot.inventory.emit("updateSlot", slot, null, bot.inventory.slots[slot]);
  };
  return { bot, data, put, read: () => readRecentEvents(data, bot.username, 50).events };
}

test("low durability notifies once, follows moves, and rearms after repair", async () => {
  const { bot, data, put, read } = fixture();
  put(45, 74);
  const stop = observeEquipmentEvents(bot, data);
  try {
    assert.equal(read().length, 0);
    put(45, 75); await Promise.resolve();
    assert.equal(readNotificationSummary(data, bot.username).unreadCount, 1);
    const [event] = read();
    assert.equal(event?.type, "equipment_low_durability");
    assert.equal(event?.payload && "remaining" in event.payload && event.payload.remaining, 25);
    put(45, 76); await Promise.resolve();
    put(10, 76); put(45, null); await Promise.resolve();
    put(45, 76); put(10, null); await Promise.resolve();
    assert.equal(read().length, 0, "damage and inventory transfers are not new warnings");
    put(45, 20); await Promise.resolve();
    put(45, 75); await Promise.resolve();
    assert.equal(read().length, 1, "a repaired item can cross the threshold again");
  } finally { stop(); data.close(); }
});

test("already worn equipment warns once; swapping two identical tools preserves warnings", async () => {
  const { bot, data, put, read } = fixture();
  put(36, 80, "iron_sword"); put(10, 0, "iron_sword");
  const stop = observeEquipmentEvents(bot, data);
  try {
    assert.equal(read().length, 1);
    put(36, 0, "iron_sword"); put(10, 80, "iron_sword"); await Promise.resolve();
    assert.equal(read().length, 0);
  } finally { stop(); data.close(); }
});

test("only our native break statuses create break notices, including after slot removal", async () => {
  const { bot, data, put, read } = fixture();
  put(45, 99);
  const stop = observeEquipmentEvents(bot, data);
  try {
    read();
    put(45, null); await Promise.resolve();
    assert.equal(read().length, 0, "removal alone is not a break");
    bot._client.emit("entity_status", { entityId: bot.entity.id + 1, entityStatus: 48 });
    bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: 29 });
    assert.equal(read().length, 0);
    bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: 48 });
    const [event] = read();
    assert.equal(event?.type, "equipment_broken");
    assert.equal(event?.summary, "shield broke.");
    for (const [status, slot, name] of [[47, 36, "iron_sword"], [49, 5, "iron_helmet"],
      [50, 6, "iron_chestplate"], [51, 7, "iron_leggings"], [52, 8, "iron_boots"]] as const) {
      put(slot, 99, name); await Promise.resolve(); read();
      bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: status });
      assert.equal(read()[0]?.summary, `${name} broke.`);
    }
  } finally { stop(); data.close(); }
});

test("disposal detaches listeners and prevents queued database writes", async () => {
  const { bot, data, put, read } = fixture();
  const slots = bot.inventory.listenerCount("updateSlot");
  const statuses = bot._client.listenerCount("entity_status");
  const stop = observeEquipmentEvents(bot, data);
  put(45, 90);
  stop(); stop();
  await Promise.resolve();
  assert.equal(read().length, 0);
  assert.equal(bot.inventory.listenerCount("updateSlot"), slots);
  assert.equal(bot._client.listenerCount("entity_status"), statuses);
  data.close();
});
