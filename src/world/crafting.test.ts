import assert from "node:assert/strict";
import test from "node:test";
import { craftingBot } from "../test-support/crafting.js";
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
