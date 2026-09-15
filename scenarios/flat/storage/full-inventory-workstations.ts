import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { placeBlockResultSchema } from "@aibengineering/mine-ai-mcp";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "full-inventory-workstations");
  const craft = runtime.actions.find((action) => action.name === "craft_item")!;
  const place = runtime.actions.find((action) => action.name === "place_block")!;
  const container = runtime.actions.find((action) => action.name === "use_container")!;
  const smelt = runtime.actions.find((action) => action.name === "smelt_item")!;
  try {
    assert.equal(bot.inventory.emptySlotCount(), 0, "start with a genuinely full inventory");
    const chestCraft = await runtime.run(craft, { items: [{ item_name: "chest", count: 1 }] }, signal);
    assert.equal(chestCraft.result.status, "succeeded", JSON.stringify(chestCraft));
    const chest = await runtime.run(place, { block_name: "chest" }, signal);
    assert.equal(chest.result.status, "succeeded", JSON.stringify(chest));
    const chestAt = placeBlockResultSchema.parse(chest.result).placement.target;
    const deposit = await runtime.run(
      container,
      {
        operation: "deposit",
        ...chestAt,
        items: [{ item_name: "cobblestone", count: 128 }],
      },
      signal,
    );
    assert.equal(deposit.result.status, "succeeded", JSON.stringify(deposit));
    assert.ok(bot.inventory.emptySlotCount() >= 3);
    const furnaceCraft = await runtime.run(craft, { items: [{ item_name: "furnace", count: 1 }] }, signal);
    assert.equal(furnaceCraft.result.status, "succeeded", JSON.stringify(furnaceCraft));
    const furnace = await runtime.run(place, { block_name: "furnace" }, signal);
    assert.equal(furnace.result.status, "succeeded", JSON.stringify(furnace));
    const furnaceAt = placeBlockResultSchema.parse(furnace.result).placement.target;
    const cooked = await runtime.run(
      smelt,
      {
        ...furnaceAt,
        item_name: "beef",
        count: 2,
        fuel_item_name: "coal",
      },
      signal,
    );
    assert.equal(cooked.result.status, "succeeded", JSON.stringify(cooked));
    const block = bot.blockAt(new Vec3(chestAt.x, chestAt.y, chestAt.z));
    assert.ok(block);
    const chestWindow = await bot.openContainer(block);
    try {
      assert.equal(
        chestWindow
          .containerItems()
          .filter((item) => item.name === "cobblestone")
          .reduce((count, item) => count + item.count, 0),
        128,
      );
    } finally {
      chestWindow.close();
    }
    return {
      status: "succeeded",
      detail:
        "Full inventory resolved through chest crafting and deposit; reused existing table, placed a furnace, and cooked two beef without new action policy.",
    };
  } finally {
    await runtime.close();
  }
};
