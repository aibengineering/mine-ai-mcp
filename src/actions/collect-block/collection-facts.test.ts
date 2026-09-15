import assert from "node:assert/strict";
import { test } from "node:test";
import { botFixture, registry } from "../../test-support/bot.js";

import { blockMatchesSelector, expectedDropName, inventoryCounts, inventoryGains } from "./collection-facts.js";

function factsBot(
  items: Array<{ name: string; count: number; type: number }> = [],
  heldItem: { enchants: Array<{ name: string; lvl: number }> } | null = null,
) {
  return botFixture({ items }, { heldItem });
}

test("matches only Collect's supported resource families", () => {
  assert.equal(blockMatchesSelector("oak_log", "logs"), true);
  assert.equal(blockMatchesSelector("stripped_oak_log", "log"), true);
  assert.equal(blockMatchesSelector("oak_wood", "logs"), false);
  assert.equal(blockMatchesSelector("deepslate_iron_ore", "iron_ore"), true);
  assert.equal(blockMatchesSelector("deepslate", "stone"), false);
});

test("chooses the equipped tool's Minecraft loot and keeps the ordinary-break upstream override", () => {
  assert.equal(expectedDropName(factsBot(), "stone"), "cobblestone");
  assert.equal(expectedDropName(factsBot(), "clay"), "clay_ball");
  assert.equal(expectedDropName(factsBot([], { enchants: [{ name: "silk_touch", lvl: 1 }] }), "stone"), "stone");
  assert.equal(expectedDropName(factsBot(), "short_grass"), "wheat_seeds");
  assert.equal(expectedDropName(factsBot(), "cobweb"), "string");
});

test("adds only Collect's before-and-after interpretation to Mineflayer inventory facts", () => {
  const items = [
    { name: "oak_log", count: 2, type: registry.itemsByName.oak_log.id },
    { name: "oak_log", count: 3, type: registry.itemsByName.oak_log.id },
    { name: "dirt", count: 4, type: registry.itemsByName.dirt.id },
  ];
  const bot = factsBot(items);

  assert.deepEqual(inventoryCounts(bot), { oak_log: 5, dirt: 4 });
  assert.deepEqual(inventoryGains(bot, { oak_log: 1, dirt: 8 }, ["dirt", "oak_log", "oak_log"]), { oak_log: 4 });
});
