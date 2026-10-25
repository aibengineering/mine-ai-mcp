import assert from "node:assert/strict";
import { z } from "zod";
import { craftItemResultSchema, smeltItemResultSchema, viewBlocksResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ table: positionSchema, furnace: positionSchema });

/** Keep intermediate recipe evidence before later steps consume the crafted items. */
export const run: ScenarioRun = async (context) => {
  const { table, furnace } = paramsSchema.parse(context.scenario.params);
  const call = async (action: string, input: Record<string, unknown>) => {
    const output = await context.call(action, input);
    assert.equal(output.result.status, "succeeded", output.summary);
    return output.result;
  };
  const inventory = async () => {
    const { situation } = viewStatusResultSchema.parse(await call("view_status", {}));
    return (name: string) => situation.inventory.stacks
      .filter((item) => item.name === name && (item.location === "main" || item.location === "hotbar"))
      .reduce((total, item) => total + item.count, 0);
  };

  // This exact nine-log batch reproduced the original inventory synchronization failure.
  const batch = craftItemResultSchema.parse(await call("craft_item", {
    items: [{ item_name: "crafting_table", count: 1 }, { item_name: "oak_planks", count: 32 }],
  }));
  assert.ok(batch.craft.items.every((item) => item.confirmed), "Every recipe receipt must be confirmed.");
  const carriedCount = await inventory();
  assert.equal(carriedCount("crafting_table"), 1);
  assert.equal(carriedCount("oak_planks"), 32);
  assert.equal(carriedCount("oak_log"), 0);

  await call("place_block", { block_name: "crafting_table", ...table });
  const doors = craftItemResultSchema.parse(await call("craft_item", {
    items: [{ item_name: "oak_door", count: 1 }],
  }));
  assert.ok(doors.craft.items.every((item) => item.confirmed), "Door output must be confirmed.");
  assert.equal(doors.craft.items.find((item) => item.item === "oak_door")?.gained, 3);

  await call("place_block", { block_name: "furnace", ...furnace });
  const placed = smeltItemResultSchema.parse(await call("smelt_item", {
    ...furnace, item_name: "raw_iron", count: 2, fuel_item_name: "coal",
  }));
  const afterPlaced = await inventory();
  assert.equal(afterPlaced("iron_ingot"), 2, "Placed furnace: exactly two ingots must be carried.");
  assert.equal(afterPlaced("raw_iron"), 9, "Placed furnace: preserve the next batch's nine inputs.");
  assert.equal(placed.smelt.produced, 2, "Placed furnace receipt must agree with inventory.");
  assert.equal(placed.smelt.rawRecovered, 0);
  const standing = viewBlocksResultSchema.parse(await call("view_blocks", { cells: [furnace] }));
  assert.equal(standing.blocks.cells[0]?.name, "furnace", "An explicitly placed furnace must remain in the world.");

  // Removing the table first recreates the floating-furnace collection regression.
  await call("collect_block", { block_name: "crafting_table", count: 1, ...table, scaffold: false });
  await call("collect_block", { block_name: "furnace", count: 1, ...furnace, scaffold: false });
  assert.equal((await inventory())("furnace"), 1, "Floating furnace must be recovered before the temporary batch.");

  // At 16 TPS nine items need 112.5 seconds, beyond the old 95-second
  // deadline, and require a second coal. No placed furnace remains to reuse.
  const temporary = smeltItemResultSchema.parse(await call("smelt_item", {
    temporary_workstation: true, item_name: "raw_iron", count: 9, fuel_item_name: "coal",
  }));
  const afterTemporary = await inventory();
  assert.equal(afterTemporary("iron_ingot"), 11, "Temporary furnace: recover all nine newly cooked ingots.");
  assert.equal(afterTemporary("raw_iron"), 0, "A slow cook must not recover unfinished raw input.");
  assert.equal(afterTemporary("furnace"), 1);
  assert.equal(temporary.smelt.produced, 9, "Temporary furnace receipt must agree with inventory.");
  assert.equal(temporary.smelt.rawRecovered, 0);
  assert.equal(temporary.workstation?.recovered, true);

  // A temporary table may craft a batch that includes another table; the
  // carried one is placed, used and recovered, and the new one is counted once.
  const batch2 = craftItemResultSchema.parse(await call("craft_item", {
    temporary_workstation: true,
    items: [{ item_name: "stone_pickaxe" }, { item_name: "stone_axe" }, { item_name: "crafting_table" }],
  }));
  assert.equal(batch2.workstation?.recovered, true, "The temporary table must be recovered.");
  const tableOutput = batch2.craft.items.find((item) => item.item === "crafting_table");
  assert.equal(tableOutput?.gained, 1);
  assert.equal(tableOutput.inventoryBefore, 1);
  assert.equal(tableOutput.inventoryAfter, 2);
  assert.equal((await inventory())("crafting_table"), 2);

  // A plan that cannot be met still returns the table it placed for this call.
  const failedOutput = await context.call("craft_item", {
    temporary_workstation: true, items: [{ item_name: "diamond_pickaxe" }],
  });
  assert.equal(failedOutput.result.status, "failed", failedOutput.summary);
  const failed = craftItemResultSchema.parse(failedOutput.result);
  assert.equal(failed.workstation?.recovered, true, "A failed plan must still recover its table.");
  assert.equal((await inventory())("crafting_table"), 2);
  const used = [temporary, batch2, failed].map((result) => result.workstation!.position);
  const cells = viewBlocksResultSchema.parse(await call("view_blocks", { cells: used })).blocks.cells;
  assert.deepEqual(cells.map((cell) => cell.name), used.map(() => "air"), "Every temporary workstation cell must be empty again.");
  return { status: "succeeded", detail: "Nine-log batch and three-door output confirmed; placed furnace cooked two; floating furnace recovered; temporary furnace cooked nine at 16 TPS and was recovered; temporary table crafted a batch with a table and was recovered, also after a failed plan." };
};
