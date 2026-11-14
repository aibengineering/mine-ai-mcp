import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../../test-support/bot.js";
import { DRAGON_PROTECTION_BLOCKS, capBlock, countCapBlocks } from "./hide-blocks.js";

/** Only names and counts matter; the shared bot double supplies the 1.21.4 registry. */
function carried(...stacks: ReadonlyArray<readonly [string, number]>) {
  return botFixture({ items: stacks.map(([name, count]) => ({ name, count })) });
}

test("any carried safe full block can close a defensive wall", () => {
  const bot = carried(
    ["cobblestone", 8],
    ["dirt", 4],
    ["acacia_planks", 3],
    ["deepslate", 2],
    ["blackstone", 5],
    ["tuff", 6],
    ["bricks", 7],
  );

  assert.equal(countCapBlocks(bot), 35);
});

test("the cheap emergency list keeps its preference over a fallback block", () => {
  const cobble = carried(["acacia_planks", 3], ["dirt", 4], ["cobblestone", 8]);
  assert.equal(capBlock(cobble)?.name, "cobblestone");

  const dirt = carried(["acacia_planks", 3], ["dirt", 4]);
  assert.equal(capBlock(dirt)?.name, "dirt");
});

test("partial, falling, interactive and liquid items are not wall material", () => {
  const bot = carried(
    ["oak_slab", 16],
    ["sand", 16],
    ["gravel", 16],
    ["chest", 1],
    ["furnace", 1],
    ["crafting_table", 1],
    ["ladder", 16],
    ["water_bucket", 1],
  );

  assert.equal(countCapBlocks(bot), 0);
  assert.equal(capBlock(bot), null);
});

test("an explicit block list never falls back to the broader defensive material", () => {
  const bot = carried(["cobblestone", 64], ["acacia_planks", 16]);

  assert.equal(countCapBlocks(bot, DRAGON_PROTECTION_BLOCKS), 0);
  assert.equal(capBlock(bot, DRAGON_PROTECTION_BLOCKS), null);
});

test("an explicit dragon list still counts and selects only its resistant blocks", () => {
  const bot = carried(["cobblestone", 64], ["end_stone", 6], ["obsidian", 4]);

  assert.equal(countCapBlocks(bot, DRAGON_PROTECTION_BLOCKS), 10);
  assert.equal(capBlock(bot, DRAGON_PROTECTION_BLOCKS)?.name, "end_stone");
});
