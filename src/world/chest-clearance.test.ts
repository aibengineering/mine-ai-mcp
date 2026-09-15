import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import prismarineBlock from "prismarine-block";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { chestOpeningObstruction } from "./chest-clearance.js";

test("chest clearance distinguishes deepslate from transparent and partial blocks", () => {
  const registry = minecraftData("1.21.4");
  const Block = prismarineBlock("1.21.4");
  const at = new Vec3(-115, -50, 9);
  for (const name of ["deepslate", "air", "glass", "oak_slab"]) {
    const block = Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);
    const bot = {
      blockAt: (cell: Vec3) => {
        assert.equal(cell.y, -49);
        return block;
      },
    } as unknown as Bot;
    const error = chestOpeningObstruction(bot, "chest", at);
    if (name === "deepslate") assert.match(error ?? "", /CHEST_BLOCKED.*deepslate/);
    else assert.equal(error, null);
    assert.equal(chestOpeningObstruction(bot, "barrel", at), null);
  }
});
