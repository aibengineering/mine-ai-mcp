import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { enchantmentsOf } from "./enchantments.js";

const bot = {
  registry: { enchantments: { 19: { name: "efficiency" }, 33: { name: "silk_touch" } } },
} as unknown as Bot;
type Item = Parameters<typeof enchantmentsOf>[1];

test("an NBT-era enchantment list passes through unchanged", () => {
  const item = { enchants: [{ name: "efficiency", lvl: 3 }] } as unknown as Item;
  assert.deepEqual(enchantmentsOf(bot, item), [{ name: "efficiency", lvl: 3 }]);
});

test("a 1.21 enchantments component is read as a name and level list", () => {
  const item = {
    enchants: {
      enchantments: [
        { id: 19, level: 2 },
        { id: 33, level: 1 },
      ],
      showInTooltip: true,
    },
  } as unknown as Item;
  assert.deepEqual(enchantmentsOf(bot, item), [
    { name: "efficiency", lvl: 2 },
    { name: "silk_touch", lvl: 1 },
  ]);
});

test("an empty component, a missing item, or unknown data is no enchantment at all", () => {
  assert.deepEqual(enchantmentsOf(bot, { enchants: {} } as unknown as Item), []);
  assert.deepEqual(enchantmentsOf(bot, null), []);
  assert.deepEqual(enchantmentsOf(bot, { enchants: undefined } as unknown as Item), []);
});
