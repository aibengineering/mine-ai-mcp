import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { craftingBot } from "../../test-support/crafting.js";
import {
  createCraftItemAction,
  formatCraftItemResult,
  parseCraftItemRequest,
  craftItem,
} from "./index.js";
const navigation = {} as NavigationRuntime;

test("parses, normalizes, and combines a non-empty item batch", () => {
  assert.deepEqual(
    parseCraftItemRequest({
      items: [
        { item_name: " Minecraft:Stone Pickaxe ", count: 2 },
        { item_name: "stick" },
        { item_name: "stick", count: 3 },
      ],
    }),
    {
      items: [
        { itemName: "stone_pickaxe", count: 2 },
        { itemName: "stick", count: 4 },
      ],
    },
  );
  assert.throws(() => parseCraftItemRequest({ items: [] }));
  assert.throws(() => parseCraftItemRequest({ items: [{ item_name: "stick", count: 0 }] }));
  assert.throws(() => parseCraftItemRequest({ item_name: "stick", count: 1 }));
});

/** One shared plan per request, executed leaf-first, reporting only observed inventory gains. */
const completedBatches = [
  {
    name: "one target reached through its intermediate",
    carried: { oak_log: 1 },
    tableAvailable: false,
    items: [{ itemName: "stick", count: 4 }],
    craftCalls: ["oak_planks", "stick"],
    gains: [{ item: "stick", gained: 4 }],
  },
  {
    name: "two targets sharing one inventory plan",
    carried: { oak_log: 1 },
    tableAvailable: false,
    items: [
      { itemName: "stick", count: 4 },
      { itemName: "oak_button", count: 1 },
    ],
    craftCalls: ["oak_planks", "stick", "oak_button"],
    gains: [
      { item: "stick", gained: 4 },
      { item: "oak_button", gained: 1 },
    ],
  },
  {
    // A recipe batch may overshoot the request; the whole batch still confirms it.
    name: "a whole recipe batch larger than the request",
    carried: { oak_planks: 2 },
    tableAvailable: false,
    items: [{ itemName: "stick", count: 1 }],
    craftCalls: ["stick"],
    gains: [{ item: "stick", gained: 4 }],
  },
  {
    name: "a tool crafted recursively at a nearby table",
    carried: { oak_log: 1, cobblestone: 3 },
    tableAvailable: true,
    items: [{ itemName: "stone_pickaxe", count: 1 }],
    craftCalls: ["oak_planks", "stick", "stone_pickaxe"],
    gains: [{ item: "stone_pickaxe", gained: 1 }],
  },
] as const;

test("crafts each requested target and reports the gain actually observed in inventory", async () => {
  for (const row of completedBatches) {
    const { bot, craftCalls } = craftingBot({ ...row.carried }, row.tableAvailable);
    const result = await craftItem(bot, navigation, { items: [...row.items] }, {});

    assert.equal(result.status, "succeeded", row.name);
    assert.deepEqual(craftCalls, [...row.craftCalls], row.name);
    assert.deepEqual(
      result.craft.items.map(({ item, gained }) => ({ item, gained })),
      row.gains,
      row.name,
    );
    assert.equal(result.craft.completedSteps, row.craftCalls.length, row.name);
    assert.ok(
      result.craft.items.every(({ confirmed }) => confirmed),
      `${row.name}: every requested target is confirmed`,
    );
    assert.doesNotMatch(formatCraftItemResult(result), /not confirmed/, row.name);
    assert.match(formatCraftItemResult(result), /Selected recipe paths/, row.name);
  }
});

/** A plan short of any leaf material is refused whole: nothing is consumed and nothing is crafted. */
const missingMaterialBatches = [
  {
    name: "one missing leaf across two targets",
    carried: { oak_log: 1 },
    items: [
      { itemName: "stick", count: 4 },
      { itemName: "crafting_table", count: 1 },
    ],
    requiredMaterials: [{ item: "oak_log", count: 2 }],
    carriedMaterials: [{ item: "oak_log", count: 1 }],
    missingMaterials: [{ item: "oak_log", count: 1 }],
    requiresCraftingTable: false,
    markdown: /Carried leaf materials reserved: oak_log ×1/,
    tree: /oak_log x1/,
  },
  {
    // Without a nearby table the plan must add the table's own materials.
    name: "the workstation's own materials",
    carried: { oak_log: 1, cobblestone: 3 },
    items: [{ itemName: "stone_pickaxe", count: 1 }],
    requiredMaterials: undefined,
    carriedMaterials: undefined,
    missingMaterials: undefined,
    requiresCraftingTable: true,
    markdown: undefined,
    tree: undefined,
  },
  {
    name: "the extra log a reserved plank, stick and tool batch still needs",
    carried: { oak_log: 10, cobblestone: 13 },
    items: [
      { itemName: "oak_planks", count: 32 },
      { itemName: "stick", count: 12 },
      { itemName: "stone_pickaxe", count: 1 },
      { itemName: "stone_axe", count: 1 },
    ],
    requiredMaterials: undefined,
    carriedMaterials: undefined,
    missingMaterials: [{ item: "oak_log", count: 1 }],
    requiresCraftingTable: true,
    markdown: undefined,
    tree: /crafting_table/,
  },
] as const;

test("reports the combined materials a batch is short of without consuming any ingredient", async () => {
  for (const row of missingMaterialBatches) {
    const { bot, craftCalls } = craftingBot({ ...row.carried });
    const result = await craftItem(bot, navigation, { items: [...row.items] }, {});

    assert.equal(result.status, "failed", row.name);
    assert.match("error" in result ? result.error : "", /CRAFT_MATERIALS_MISSING/, row.name);
    assert.deepEqual(craftCalls, [], `${row.name}: a refused plan crafts nothing`);
    assert.equal(result.craft.plan?.requiresCraftingTable, row.requiresCraftingTable, row.name);
    if (row.requiredMaterials) assert.deepEqual(result.craft.plan?.requiredMaterials, row.requiredMaterials, row.name);
    if (row.carriedMaterials) assert.deepEqual(result.craft.plan?.carriedMaterials, row.carriedMaterials, row.name);
    if (row.missingMaterials) assert.deepEqual(result.craft.plan?.missingMaterials, row.missingMaterials, row.name);
    if (row.tree) assert.match(result.craft.plan?.tree ?? "", row.tree, row.name);
    if (row.markdown) assert.match(formatCraftItemResult(result), row.markdown, row.name);
  }
});

test("temporary crafting requires a carried table even with a nearby table and bootstrap ingredients", async () => {
  const { bot, craftCalls } = craftingBot({ oak_log: 10, cobblestone: 3 }, true);
  const request = parseCraftItemRequest({ temporary_workstation: true, items: [{ item_name: "stone_pickaxe" }] });
  assert.equal(request.temporaryWorkstation, true);
  const result = await craftItem(bot, navigation, request, {});
  assert.equal(result.status, "failed");
  assert.match(result.error, /WORKSTATION_NOT_CARRIED.*crafting_table/);
  assert.deepEqual(craftCalls, []);
});

test("a native crafting failure claims no output and still asks for the inventory window to close", async () => {
  const { bot } = craftingBot({ oak_log: 1 });
  const closed: unknown[] = [];
  Object.assign(bot, {
    closeWindow: (window: unknown) => {
      closed.push(window);
    },
    craft: async () => {
      throw new Error("Server did not supply the expected crafting result");
    },
  });

  const result = await craftItem(bot, navigation, { items: [{ itemName: "crafting_table", count: 1 }] }, {});

  assert.equal(result.status, "failed");
  assert.match(
    "error" in result ? result.error : "",
    /CRAFT_EXECUTION_FAILED.*Server did not supply the expected crafting result/,
  );
  assert.equal(result.craft.items[0].gained, 0);
  // These are close requests; server-side item return is asynchronous.
  assert.deepEqual(closed, [bot.inventory, bot.inventory]);
});

test("caller cancellation stops a recursive plan between recipe effects", async () => {
  const { bot } = craftingBot({ oak_log: 1 });
  const controller = new AbortController();
  const originalCraft = bot.craft.bind(bot);
  let calls = 0;
  bot.craft = async (...argumentsValue) => {
    await originalCraft(...argumentsValue);
    calls += 1;
    if (calls === 1) controller.abort(new Error("stop recursive crafting"));
  };

  const output = await new ActionRunner().run(
    createCraftItemAction(bot, navigation),
    { items: [{ item_name: "stick", count: 4 }] },
    controller.signal,
  );

  assert.equal(output.result.status, "cancelled");
  assert.equal(calls, 1);
});
