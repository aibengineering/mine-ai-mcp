import assert from "node:assert/strict";
import test from "node:test";
import { craftingBot } from "../../test-support/crafting.js";
import { formatViewCraftingRequirementsResult, viewCraftingRequirements } from "./index.js";

/**
 * Every requirements answer over the same planner, varying only what is carried
 * and what is asked for. Missing materials and an item with no recipe are
 * information, not failures; only an item Minecraft does not have is a failure.
 * Which materials a plan requires and reserves is the planner's contract, proven
 * in utils/craft-plan.test.ts; these rows prove only what the action decides.
 */
const rows = [
  {
    name: "a shared plan the carried materials already satisfy",
    carried: { oak_log: 1 },
    items: [
      { itemName: "stick", count: 4 },
      { itemName: "oak_button", count: 1 },
    ],
    status: "succeeded",
    planStatus: "ready",
    markdown: /stick ×4/,
  },
  {
    name: "materials the bot does not carry",
    carried: {},
    items: [{ itemName: "stone_pickaxe", count: 1 }],
    status: "succeeded",
    planStatus: "missing_materials",
    markdown: /Carried leaf materials reserved: none/,
  },
  {
    name: "a known item with no recipe",
    carried: {},
    items: [{ itemName: "apple", count: 1 }],
    status: "succeeded",
    planStatus: "uncraftable",
    markdown: undefined,
  },
  {
    name: "an item Minecraft does not have",
    carried: {},
    items: [{ itemName: "definitely_not_an_item", count: 1 }],
    status: "failed",
    planStatus: undefined,
    markdown: /UNKNOWN_CRAFT_ITEMS/,
  },
] as const;

test("reports what a craft batch would need without crafting anything", async () => {
  for (const row of rows) {
    const { bot, craftCalls } = craftingBot({ ...row.carried });
    const result = await viewCraftingRequirements(bot, { items: [...row.items] }, {});

    assert.equal(result.status, row.status, row.name);
    assert.equal(craftCalls.length, 0, `${row.name}: inspection must never craft`);
    if (row.planStatus === undefined) assert.equal(result.requirements.plan, undefined, row.name);
    else assert.equal(result.requirements.plan?.status, row.planStatus, row.name);
    if (row.markdown)
      assert.match(
        result.status === "failed" ? result.error : formatViewCraftingRequirementsResult(result),
        row.markdown,
        row.name,
      );
  }
});
