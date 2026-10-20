import assert from "node:assert/strict";
import { z } from "zod";
import { craftItemResultSchema, smeltItemResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ furnace: positionSchema });

/**
 * Each craft must report the output it gained, confirmed by the server, and the
 * smelt must report every ingot it cooked. Mine Labs then reads the exact
 * inventory, so a receipt that disagrees with what is carried fails one or the
 * other.
 */
export const run: ScenarioRun = async (context) => {
  const { furnace } = paramsSchema.parse(context.scenario.params);
  const call = async (action: string, input: Record<string, unknown>) => {
    const output = await context.call(action, input);
    assert.equal(output.result.status, "succeeded", output.summary);
    return output.result;
  };
  const craft = async (item: string, count: number) => {
    const { craft: receipt } = craftItemResultSchema.parse(
      await call("craft_item", { items: [{ item_name: item, count }] }),
    );
    const output = receipt.items.find((entry) => entry.item === item);
    assert.ok(output?.confirmed, `${item}: the server must confirm the output.`);
    assert.equal(output.gained, count, `${item}: gained`);
    assert.equal(output.inventoryAfter - output.inventoryBefore, count, `${item}: carried count moved`);
  };

  // Blaze rods become powder first; six eyes leave one pearl and nothing else.
  await craft("ender_eye", 6);
  // Recipes with container remainders give the bottles and buckets back.
  await craft("honey_block", 1);
  await craft("cake", 1);
  // Sixteen items at the normal tick rate need exactly two coal.
  const { smelt } = smeltItemResultSchema.parse(await call("smelt_item", {
    ...furnace, item_name: "raw_iron", count: 16, fuel_item_name: "coal",
  }));
  assert.equal(smelt.produced, 16, "The smelt receipt must report all sixteen ingots.");
  assert.equal(smelt.rawRecovered, 0);
  return { status: "succeeded", detail: "Six eyes via powder, honey block and cake with their containers, and sixteen ingots confirmed." };
};
