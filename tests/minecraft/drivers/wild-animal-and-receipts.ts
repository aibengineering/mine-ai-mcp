import assert from "node:assert/strict";
import {
  MOB_KINDS,
  craftItemResultSchema,
  eatFoodResultSchema,
  formatViewStatusResult,
  huntMobResultSchema,
  placeBlockResultSchema,
  viewStatusResultSchema,
} from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

/**
 * Animals with a drop every adult kill yields. Leather, feathers and rabbit
 * hide are chances, so they would make this a loot-table test.
 */
const QUARRY = new Map([["cow", "beef"], ["sheep", "mutton"], ["pig", "porkchop"], ["chicken", "chicken"]]);

/** A receipt's count moved by exactly what the act was worth, confirmed by the server. */
function moved(label: string, receipt: { inventoryBefore: number; inventoryAfter: number; confirmed: boolean }, delta: number) {
  assert.ok(receipt.confirmed, `${label}: the server did not confirm the count`);
  assert.equal(receipt.inventoryAfter - receipt.inventoryBefore, delta, `${label}: ${receipt.inventoryBefore} -> ${receipt.inventoryAfter}`);
}

/**
 * On generated terrain the seed decides what lives nearby, so the hunt's
 * species comes from the loaded-mob summary, as any caller would choose it.
 * Then three receipts on the same terrain must report exact, confirmed counts.
 */
export const run: ScenarioRun = async (context) => {
  const status = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(status.status, "succeeded");
  const { mobs } = status.situation.nearby;
  assert.ok(mobs.length > 0, "The seed must have loaded mobs, or the summary proves nothing.");
  const markdown = formatViewStatusResult(status);
  for (const [index, mob] of mobs.entries()) {
    assert.ok(MOB_KINDS.includes(mob.kind), `${mob.name} published kind ${mob.kind}`);
    const previous = mobs[index - 1];
    assert.ok(!previous || previous.nearest.distance <= mob.nearest.distance, `${mob.name} is listed out of distance order`);
    assert.ok(markdown.includes(`- ${mob.name} (${mob.kind}`), `The Markdown does not list ${mob.name}.`);
  }

  const quarry = mobs.find((mob) => QUARRY.has(mob.name));
  assert.ok(quarry, `No huntable animal is loaded; status saw ${mobs.map((mob) => mob.name).join(", ")}.`);
  const dropName = QUARRY.get(quarry.name)!;
  const hunted = await context.call("collect_mob_drop", { mob_name: quarry.name, drop_name: dropName, count: 1 });
  const hunt = huntMobResultSchema.parse(hunted.result);
  assert.equal(hunt.status, "succeeded", hunted.summary);
  assert.ok(hunt.hunt.gained >= 1, `The ${dropName} never arrived.`);
  assert.ok(hunt.hunt.targets.length > 0, "The result must say where the animal was.");

  const eaten = eatFoodResultSchema.parse((await context.call("eat_food", { food_name: "bread" })).result);
  assert.equal(eaten.status, "succeeded");
  assert.ok(eaten.eating.consumed, "A bite must be taken.");
  moved("eat bread", eaten.eating, -1);
  // No coordinates: the action picks a clear cell beside the bot on terrain nobody surveyed.
  const placed = placeBlockResultSchema.parse((await context.call("place_block", { block_name: "cobblestone" })).result);
  assert.equal(placed.status, "succeeded");
  moved("place cobblestone", placed.placement, -1);
  const crafted = craftItemResultSchema.parse((await context.call("craft_item", { items: [{ item_name: "stick", count: 4 }] })).result);
  assert.equal(crafted.status, "succeeded");
  moved("craft stick", crafted.craft.items[0]!, 4);
  return { status: "succeeded", detail: `${mobs.length} species loaded; hunted ${quarry.name} for ${dropName}; eat, place and craft receipts exact` };
};
