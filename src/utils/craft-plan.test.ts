import assert from "node:assert/strict";
import test from "node:test";
import { craftingBot, craftingRegistry as registry } from "../test-support/crafting.js";
import { planCraftingFromInventory } from "./craft-plan.js";

test("turns Mineflayer recipes into stable recursive steps and readable trees", () => {
  const { bot } = craftingBot({ oak_log: 1, cobblestone: 3 });
  const target = registry.itemsByName.stone_pickaxe;

  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 1 }]);

  assert.equal(preparation.kind, "ready");
  assert.deepEqual(
    preparation.plan.steps.map((step) => step.item),
    ["oak_planks", "stick", "stone_pickaxe"],
  );
  assert.deepEqual(preparation.plan.requiredMaterials, [
    { item: "cobblestone", count: 3 },
    { item: "oak_log", count: 1 },
  ]);
  assert.equal(preparation.plan.requiresCraftingTable, true);
  assert.match(preparation.plan.tree, /stone_pickaxe x1/);
  assert.match(preparation.plan.tree, /stick x2/);
  assert.match(preparation.plan.tree, /oak_log x1/);
});

test("exposes missing leaves instead of the requested item", () => {
  const { bot } = craftingBot({});
  const target = registry.itemsByName.stone_pickaxe;

  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 1 }]);

  assert.equal(preparation.kind, "missing_materials");
  assert.ok(preparation.plan.missingMaterials.length > 0);
  assert.ok(preparation.plan.missingMaterials.every((material) => material.item !== "stone_pickaxe"));
  assert.match(preparation.plan.tree, /missing/);
  assert.equal(preparation.plan.steps.at(-1)?.item, "stone_pickaxe");
});

test("distinguishes an item with no crafting recipe", () => {
  const { bot } = craftingBot({});

  const preparation = planCraftingFromInventory(bot, [{ ...registry.itemsByName.apple, count: 1 }]);

  assert.equal(preparation.kind, "uncraftable");
  assert.deepEqual(preparation.items, ["apple"]);
  assert.equal(preparation.plan.tree, "apple x1");
});

test("returns executable applications in dependency order", () => {
  const { bot } = craftingBot({ oak_log: 1 });
  const target = registry.itemsByName.stick;
  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 4 }]);
  assert.equal(preparation.kind, "ready");

  assert.deepEqual(
    preparation.applications.map(({ recipe }) => registry.items[recipe.result.id].name),
    ["oak_planks", "stick"],
  );
});

test("shares intermediate surplus across requested targets", () => {
  const { bot } = craftingBot({ oak_log: 1 });

  const preparation = planCraftingFromInventory(bot, [
    { ...registry.itemsByName.stick, count: 4 },
    { ...registry.itemsByName.oak_button, count: 1 },
  ]);

  assert.equal(preparation.kind, "ready");
  assert.deepEqual(preparation.plan.requiredMaterials, [{ item: "oak_log", count: 1 }]);
  assert.match(preparation.plan.tree, /stick x4/);
  assert.match(preparation.plan.tree, /oak_button x1/);
});

test("reserves one shared inventory before declaring a batch ready", () => {
  const { bot } = craftingBot({ oak_log: 1 });

  const preparation = planCraftingFromInventory(bot, [
    { ...registry.itemsByName.stick, count: 4 },
    { ...registry.itemsByName.crafting_table, count: 1 },
  ]);

  assert.equal(preparation.kind, "missing_materials");
  assert.deepEqual(preparation.plan.missingMaterials, [{ item: "oak_log", count: 1 }]);
});
