import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Bot } from "mineflayer";
import { craftingBot, craftingRegistry } from "../test-support/crafting.js";
import { planCraftingFromInventory } from "../utils/craft-plan.js";
import { executeCraftPlan } from "./crafting.js";

test("a full inventory refuses the first planks application before its output would be dropped", async () => {
  const { bot, craftCalls, counts } = craftingBot({ cobblestone: 35 * 64, oak_log: 2 });
  const target = bot.registry.itemsByName.oak_planks!;
  const plan = planCraftingFromInventory(bot, [{ id: target.id, name: target.name, count: 8 }]);
  assert.equal(plan.kind, "ready");
  const result = await executeCraftPlan(bot, plan.applications, null);
  assert.equal(result.kind, "failed");
  assert.match(String(result.cause), /execution needs inventory room.*oak_planks/);
  assert.equal(counts.get(bot.registry.itemsByName.oak_log!.id), 2);
  assert.deepEqual(craftCalls, []);
});

const capacityControls: readonly Readonly<Record<string, number>>[] = [
  { cobblestone: 34 * 64, oak_log: 2 },
  { cobblestone: 35 * 64, oak_log: 1 },
  { cobblestone: 34 * 64, oak_log: 2, oak_planks: 60 },
];
for (const carried of capacityControls) {
  test(`one application can store planks with ${JSON.stringify(carried)}`, async () => {
    const { bot, craftCalls } = craftingBot(carried);
    const target = bot.registry.itemsByName.oak_planks!;
    const selected = bot.recipesAll(target.id, null, null)[0]!;
    assert.deepEqual(await executeCraftPlan(bot, [{ recipe: selected, applications: 1 }], null), {
      kind: "completed",
      completedSteps: 1,
    });
    assert.deepEqual(craftCalls, ["oak_planks"]);
  });
}

// flat/craft/recipe-remainders: a honey block from four honey bottles hands
// back four glass bottles. With 35 stacks of cobblestone and the bottles
// filling all 36 slots, Minecraft's own recipe delta needs two free slots
// after the bottles are spent and only one exists, so the craft is refused
// before any click rather than letting the inventory toss a remainder.
const nativeRecipes = (createRequire(import.meta.url)("prismarine-recipe") as (registry: unknown) => {
  Recipe: { find(itemType: number, metadata: null): ReturnType<Bot["recipesAll"]> };
})(craftingRegistry).Recipe;
for (const [cobblestone, refused] of [[35 * 64, true], [34 * 64, false]] as const) {
  test(`container remainders count toward room: honey block with ${cobblestone} cobblestone is ${refused ? "refused" : "crafted"}`, async () => {
    const { bot, craftCalls, counts } = craftingBot({ cobblestone, honey_bottle: 4 });
    const honey = nativeRecipes.find(craftingRegistry.itemsByName.honey_block!.id, null)[0]!;
    const result = await executeCraftPlan(bot, [{ recipe: honey, applications: 1 }], null);
    if (refused) {
      assert.equal(result.kind, "failed");
      assert.match(String(result.kind === "failed" ? result.cause : ""), /execution needs inventory room/);
      assert.deepEqual(craftCalls, []);
      assert.equal(counts.get(craftingRegistry.itemsByName.honey_bottle!.id), 4);
    } else {
      assert.deepEqual(result, { kind: "completed", completedSteps: 1 });
      assert.equal(counts.get(craftingRegistry.itemsByName.glass_bottle!.id), 4);
    }
  });
}
