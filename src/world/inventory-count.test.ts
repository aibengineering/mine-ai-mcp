import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { carriedCount, INVENTORY_SETTLE_MS, settleInventoryCount } from "./inventory-count.js";

/**
 * A bot whose inventory announces a slot change the way Mineflayer's does, so
 * a test can put the announcement where the server puts it: after the promise
 * the action awaited has already resolved.
 */
function inventoryBot(itemName: string, count: number) {
  const items = [{ name: itemName, count }];
  const bot = botFixture({ items });
  const setCount = (next: number) => {
    items[0]!.count = next;
    bot.inventory.emit("updateSlot");
  };
  return { bot, setCount };
}

/** Two server ticks, in the wall-clock terms the settle deadline is written in. */
const TWO_TICKS_MS = 100;

test("counts every stack of the named item and nothing else", () => {
  const bot = botFixture({
    items: [
      { name: "cooked_beef", count: 3 },
      { name: "cobblestone", count: 12 },
      { name: "cooked_beef", count: 2 },
    ],
  });

  assert.equal(carriedCount(bot, "cooked_beef"), 5);
  assert.equal(carriedCount(bot, "bread"), 0);
});

test("returns at once when the count is already the expected one", async () => {
  const { bot } = inventoryBot("cooked_beef", 1);
  const started = Date.now();

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 1, confirmed: true });
  assert.ok(Date.now() - started < INVENTORY_SETTLE_MS, "an already-right count does not wait for the deadline");
});

test("confirms a slot update that arrives two ticks after the action resolved", async () => {
  const { bot, setCount } = inventoryBot("cooked_beef", 2);
  setTimeout(() => setCount(1), TWO_TICKS_MS);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 1, confirmed: true });
});

test("reports the count it can see, unconfirmed, when the update never arrives", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 2, confirmed: false });
});

test("a caller's cancellation ends the wait with the count observed so far", async () => {
  const { bot } = inventoryBot("cobblestone", 3);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), TWO_TICKS_MS);

  const settled = await settleInventoryCount(bot, "cobblestone", 2, { signal: controller.signal });

  assert.deepEqual(settled, { count: 3, confirmed: false });
});

test("a caller with a slower server can wait longer than the default deadline", async () => {
  const { bot, setCount } = inventoryBot("gravel", 4);
  setTimeout(() => setCount(0), INVENTORY_SETTLE_MS + TWO_TICKS_MS);

  const settled = await settleInventoryCount(bot, "gravel", 0, { timeoutMs: 1_000 });

  assert.deepEqual(settled, { count: 0, confirmed: true });
});
