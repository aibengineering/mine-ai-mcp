import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { parseEatFoodRequest } from "./contract.js";
import { formatEatFoodResult, eatFood, type EatFoodDependencies } from "./eat-food.js";

/** A hungry bot carrying one stack of the named item. */
function hungryBot(name = "cooked_beef", count = 2) {
  const items: FakeStack[] = count > 0 ? [{ name, count }] : [];
  const bot = botFixture({ items }, { food: 10, foodSaturation: 2, consume: async () => undefined });
  return { bot, items };
}

test("cancellation releases a native bite without waiting for consume's bookkeeping timeout", async () => {
  const { bot } = hungryBot();
  const owner = new AbortController();
  const reason = new Error("Incoming dragon requires the body now");
  let released = false, rejectNative: (reason: Error) => void = () => {};
  bot.deactivateItem = () => { released = true; bot.usingHeldItem = false; };
  const pending = eatFood(bot, { foodName: "cooked_beef" }, { signal: owner.signal }, {
    equip: async () => {},
    consume: () => {
      bot.usingHeldItem = true;
      const native = new Promise<void>((_resolve, reject) => { rejectNative = reject; });
      queueMicrotask(() => owner.abort(reason));
      return native;
    },
  });
  await assert.rejects(pending, error => error === reason);
  assert.equal(released, true);
  assert.equal(bot.usingHeldItem, false);
  rejectNative(new Error("Late native consume timeout"));
  await new Promise(resolve => setImmediate(resolve));
});

test("parses one normalized exact food name", () => {
  assert.deepEqual(parseEatFoodRequest({ food_name: "Minecraft:Cooked Beef" }), {
    foodName: "cooked_beef",
  });
});

test("equips and consumes one named food while reporting observed changes", async () => {
  const { bot, items } = hungryBot();
  let equipped: string | null = null;
  const dependencies: EatFoodDependencies = {
    equip: async (item, destination) => {
      assert.notEqual(typeof item, "number");
      equipped = typeof item === "number" ? String(item) : item.name;
      assert.equal(destination, "hand");
    },
    consume: async () => {
      items[0]!.count -= 1;
      bot.food = 18;
      bot.foodSaturation = 14.8;
    },
  };

  const result = await eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.equal(equipped, "cooked_beef");
  assert.deepEqual(result.eating, {
    food: "cooked_beef",
    inventoryBefore: 2,
    inventoryAfter: 1,
    confirmed: true,
    hungerBefore: 10,
    hungerAfter: 18,
    saturationBefore: 2,
    saturationAfter: 14.8,
    consumed: true,
  });
  assert.match(formatEatFoodResult(result), /Consumed one \*\*cooked_beef\*\*/);
});

test("waits for consumption when Mineflayer resolves before the eating animation finishes", async () => {
  const { bot, items } = hungryBot();
  const dependencies: EatFoodDependencies = {
    equip: async () => {},
    consume: async () => {
      // A held-item update resolved consume, but the server is still eating.
      setTimeout(() => {
        items[0]!.count -= 1;
        bot.food = 18;
        bot.inventory.emit("updateSlot");
      }, 350);
    },
  };

  const result = await eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.equal(result.eating.inventoryBefore, 2);
  assert.equal(result.eating.inventoryAfter, 1);
  assert.equal(result.eating.confirmed, true);
  assert.equal(result.eating.hungerAfter, 18);
});

test("cancellation still stops the bite after consume resolves but before inventory confirmation", async () => {
  const { bot, items } = hungryBot();
  const controller = new AbortController();
  let deactivations = 0;
  bot.deactivateItem = () => { deactivations++; bot.usingHeldItem = false; };
  const pending = eatFood(bot, { foodName: "cooked_beef" }, { signal: controller.signal }, {
    equip: async () => {},
    consume: async () => { bot.usingHeldItem = true; },
  });
  const cancelled = assert.rejects(pending, /stop the bite/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bot.usingHeldItem, true);
  controller.abort(new Error("stop the bite"));
  await cancelled;
  assert.equal(deactivations, 1);
  assert.equal(items[0]!.count, 2);
  assert.equal(bot.usingHeldItem, false);
  assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
});

test("says so rather than presenting a count the server never confirmed", async () => {
  const { bot } = hungryBot();
  const dependencies: EatFoodDependencies = { equip: async () => {}, consume: async () => {}, settleMs: 50 };

  const result = await eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies);

  assert.equal(result.status, "failed");
  assert.equal(result.eating.consumed, false);
  if (result.status === "failed") assert.match(result.error, /^\[EAT_NOT_OBSERVED\]/);
  assert.deepEqual(
    [result.eating.inventoryBefore, result.eating.inventoryAfter, result.eating.confirmed],
    [2, 2, false],
  );
  assert.match(formatEatFoodResult(result), /had not confirmed this count within the deadline/);
});

test("refuses what is not food and what is not carried", async () => {
  const stone = await eatFood(hungryBot("cobblestone", 1).bot, { foodName: "cobblestone" }, {});
  assert.equal(stone.status, "failed");
  if (stone.status === "failed") assert.match(stone.error, /^\[EAT_UNKNOWN_FOOD\]/);
  assert.equal(stone.eating.consumed, false);

  const missing = await eatFood(hungryBot("apple", 0).bot, { foodName: "apple" }, {});
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") assert.match(missing.error, /^\[EAT_FOOD_MISSING\]/);
});

test("reports Mineflayer's refusal and releases an active use", async () => {
  const { bot } = hungryBot("apple", 1);
  let deactivated = false;
  bot.deactivateItem = () => {
    deactivated = true;
    bot.usingHeldItem = false;
  };
  const dependencies: EatFoodDependencies = {
    equip: async () => {},
    consume: async () => {
      bot.usingHeldItem = true;
      throw new Error("Food is full");
    },
  };

  const result = await eatFood(bot, { foodName: "apple" }, {}, dependencies);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /Food is full/);
  assert.equal(deactivated, true);
  assert.equal(result.eating.inventoryAfter, 1);
});
