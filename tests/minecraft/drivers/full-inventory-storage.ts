import assert from "node:assert/strict";
import { z } from "zod";
import {
  placeBlockResultSchema,
  queryBotDataResultSchema,
  useContainerResultSchema,
} from "@aibengineering/mine-ai-mcp";
import { playerParams } from "../driver-params.ts";
import type { ScenarioCall, ScenarioContext, ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
type Position = z.output<typeof positionSchema>;

/** Each pen names its storage case and the existing chest or lid it starts with. */
const penSchema = z.discriminatedUnion("case", [
  z.strictObject({ case: z.literal("round-trip"), chest: positionSchema }),
  z.strictObject({ case: z.literal("cramped"), chest: positionSchema, lid: positionSchema }),
  z.strictObject({ case: z.literal("full-inventory") }),
]);

type Slot = { slot: number; item: string; count: number };

function succeeded(output: ScenarioCall) {
  assert.equal(output.result.status, "succeeded", output.summary);
  return output.result;
}

async function contents(context: ScenarioContext, chest: Position): Promise<Slot[]> {
  const result = useContainerResultSchema.parse(succeeded(await context.call("use_container", { operation: "inspect", ...chest })));
  assert.ok(result.status === "succeeded");
  return result.container.contents.map(({ slot, item, count }) => ({ slot, item, count }));
}

/** The chest's slots as the bot's SQLite memory last observed them. */
async function remembered(context: ScenarioContext, chest: Position): Promise<Slot[]> {
  const sql = "SELECT slot, item_name, item_count FROM observed_container_slots " +
    `WHERE block_x = ${chest.x} AND block_y = ${chest.y} AND block_z = ${chest.z} ORDER BY slot`;
  const { query } = queryBotDataResultSchema.parse(succeeded(await context.call("query_bot_data", { sql })));
  return query.rows.map(([slot, item, count]) => ({ slot: Number(slot), item: String(item), count: Number(count) }));
}

async function place(context: ScenarioContext, block_name: string): Promise<Position> {
  return placeBlockResultSchema.parse(succeeded(await context.call("place_block", { block_name }))).placement.target;
}

const slots = (...entries: [number, string, number][]) => entries.map(([slot, item, count]) => ({ slot, item, count }));

const cases = {
  /** Organize, deposit and withdraw in a real chest; its layout and the bot's memory of it agree each time. */
  async "round-trip"(context: ScenarioContext, chest: Position) {
    succeeded(await context.call("use_container", { operation: "organize", ...chest, item_order: ["oak_log", "cobblestone"] }));
    const organized = slots([0, "oak_log", 2], [1, "cobblestone", 64], [2, "cobblestone", 6]);
    assert.deepEqual(await contents(context, chest), organized, "organized layout");
    assert.deepEqual(await remembered(context, chest), organized, "remembered organized layout");
    succeeded(await context.call("use_container", { operation: "deposit", ...chest, items: [{ item_name: "cobblestone", count: 1 }] }));
    assert.deepEqual(await contents(context, chest), slots([0, "oak_log", 2], [1, "cobblestone", 64], [2, "cobblestone", 7]),
      "a deposit fills the existing partial stack");
    succeeded(await context.call("use_container", { operation: "withdraw", ...chest, items: [{ item_name: "cobblestone", count: 3 }] }));
    const final = await contents(context, chest);
    assert.deepEqual(final.filter(({ item }) => item === "cobblestone").map(({ slot }) => slot), [1, 2]);
    assert.deepEqual(final.filter(({ item }) => item === "cobblestone").map(({ count }) => count).sort((a, b) => a - b), [4, 64]);
    assert.deepEqual(await remembered(context, chest), final, "remembered final layout");
    return "organized, deposited and withdrew; the chest and its memory agree";
  },
  /** A chest under a solid block is refused; clearing the lid with a nearly full inventory opens it. */
  async cramped(context: ScenarioContext, chest: Position, lid: Position) {
    const blocked = await context.call("use_container", { operation: "inspect", ...chest });
    assert.equal(blocked.result.status, "failed", blocked.summary);
    assert.match(blocked.result.status === "failed" ? blocked.result.error : "", /CHEST_BLOCKED.*deepslate/);
    succeeded(await context.call("collect_block", { block_name: "deepslate", ...lid }));
    await contents(context, chest);
    await contents(context, await place(context, "chest"));
    return "refused the blocked chest, cleared its lid, opened it and a placed chest";
  },
  /** From 36 occupied slots: craft and place a chest, deposit spoil, then a furnace that cooks. */
  async "full-inventory"(context: ScenarioContext) {
    succeeded(await context.call("craft_item", { items: [{ item_name: "chest", count: 1 }] }));
    const chest = await place(context, "chest");
    succeeded(await context.call("use_container", { operation: "deposit", ...chest, items: [{ item_name: "cobblestone", count: 128 }] }));
    succeeded(await context.call("craft_item", { items: [{ item_name: "furnace", count: 1 }] }));
    const furnace = await place(context, "furnace");
    succeeded(await context.call("smelt_item", { ...furnace, item_name: "beef", count: 2, fuel_item_name: "coal" }));
    const stored = (await contents(context, chest)).filter(({ item }) => item === "cobblestone").reduce((sum, { count }) => sum + count, 0);
    assert.equal(stored, 128, "The placed chest holds the deposited cobblestone.");
    return "crafted and placed a chest, deposited 128, crafted and placed a furnace, cooked two beef";
  },
};

export const run: ScenarioRun = async (context) => {
  const pen = playerParams(context, penSchema);
  const detail = pen.case === "round-trip" ? await cases["round-trip"](context, pen.chest)
    : pen.case === "cramped" ? await cases.cramped(context, pen.chest, pen.lid)
      : await cases["full-inventory"](context);
  return { status: "succeeded", detail };
};
