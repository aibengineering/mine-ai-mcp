import assert from "node:assert/strict";
import { test } from "node:test";
import minecraftData from "minecraft-data";
import PrismarineBlock from "prismarine-block";

const registry = minecraftData("1.21.4");
const Block = PrismarineBlock("1.21.4");

test("mineflayer digTime matches vanilla harvest speed for tier-gated ores", () => {
  const tool = registry.itemsByName.stone_pickaxe;
  assert.ok(tool, "stone_pickaxe exists in registry");

  const toolSpeed = registry.materials["mineable/pickaxe"]?.[tool.id] ?? 1;
  assert.ok(toolSpeed > 1, "stone pickaxe has pickaxe speed multiplier");

  const blocksToCheck = ["stone", "coal_ore", "copper_ore", "iron_ore"];
  for (const blockName of blocksToCheck) {
    const blockDef = registry.blocksByName[blockName];
    assert.ok(blockDef, `${blockName} exists in registry`);

    const block = Block.fromStateId(blockDef.defaultState, 0);
    const predicted = block.digTime(tool.id, false, false, false, [], []);

    // Vanilla Minecraft: progress per tick = toolSpeed / hardness / 30 ticks (with canHarvest)
    const progressPerTick = toolSpeed / block.hardness / 30;
    const expected = Math.ceil(1 / progressPerTick) * 50;

    const ratio = predicted / expected;
    assert.ok(
      ratio <= 1.5,
      `${blockName} dig time (${predicted}ms) exceeds expected vanilla time (${expected}ms) by ${ratio.toFixed(2)}x (upstream material tag regression)`,
    );
  }
});
