import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { craftItemResultSchema, smeltItemResultSchema } from "@aibengineering/mine-ai-mcp";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "temporary-workstations");
  const count = (name: string) =>
    bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((sum, item) => sum + item.count, 0);
  const craft = runtime.actions.find((action) => action.name === "craft_item")!;
  const smelt = runtime.actions.find((action) => action.name === "smelt_item")!;
  try {
    const crafted = craftItemResultSchema.parse(
      (
        await runtime.run(
          craft,
          {
            temporary_workstation: true,
            items: [{ item_name: "stone_pickaxe" }, { item_name: "stone_axe" }, { item_name: "crafting_table" }],
          },
          signal,
        )
      ).result,
    );
    context.log(JSON.stringify(crafted));
    assert.equal(crafted.status, "succeeded", JSON.stringify(crafted));
    assert.equal(crafted.workstation?.recovered, true);
    assert.equal(count("crafting_table"), 2);
    const tableOutput = crafted.craft.items.find((item) => item.item === "crafting_table")!;
    assert.equal(tableOutput.gained, 1);
    assert.equal(tableOutput.inventoryBefore, 1);
    assert.equal(tableOutput.inventoryAfter, 2);

    const cooked = smeltItemResultSchema.parse(
      (
        await runtime.run(
          smelt,
          {
            temporary_workstation: true,
            item_name: "beef",
            count: 2,
            fuel_item_name: "coal",
          },
          signal,
        )
      ).result,
    );
    context.log(JSON.stringify(cooked));
    assert.equal(cooked.status, "succeeded", JSON.stringify(cooked));
    assert.equal(cooked.workstation?.recovered, true);
    assert.equal(count("furnace"), 1);
    assert.equal(count("cooked_beef"), 2);

    // Failed planning still returns the table placed for this call.
    const failed = craftItemResultSchema.parse(
      (
        await runtime.run(
          craft,
          {
            temporary_workstation: true,
            items: [{ item_name: "diamond_pickaxe" }],
          },
          signal,
        )
      ).result,
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.workstation?.recovered, true);
    assert.equal(count("crafting_table"), 2);
    for (const result of [crafted, cooked, failed]) {
      const at = result.workstation!.position;
      assert.equal(bot.blockAt(new Vec3(at.x, at.y, at.z))?.name, "air");
    }
    assert.equal(bot.blockAt(new Vec3(2, -59, 0))?.name, "crafting_table");
    assert.equal(bot.blockAt(new Vec3(3, -59, 0))?.name, "furnace");
    return {
      status: "succeeded",
      detail:
        "Batch outputs, both workstation pickups, failed-plan cleanup, and existing stations independently verified.",
    };
  } finally {
    await runtime.close();
  }
};
