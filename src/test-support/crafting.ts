import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";

import { botFixture, registry, type FakeStack } from "./bot.js";

export const craftingRegistry = registry;
const CraftItem = (createRequire(import.meta.url)("prismarine-item") as (registry: object) => typeof Item)(
  craftingRegistry,
);

type Recipe = ReturnType<Bot["recipesAll"]>[number];

function recipe(
  resultName: string,
  resultCount: number,
  ingredients: Readonly<Record<string, number>>,
  requiresTable = false,
): Recipe {
  const result = craftingRegistry.itemsByName[resultName];
  assert.ok(result, `unknown recipe result ${resultName}`);
  const inputs = Object.entries(ingredients).map(([name, count]) => {
    const item = craftingRegistry.itemsByName[name];
    assert.ok(item, `unknown recipe ingredient ${name}`);
    return { id: item.id, metadata: null, count: -count };
  });
  return {
    result: { id: result.id, metadata: null, count: resultCount },
    ingredients: inputs,
    delta: [...inputs, { id: result.id, metadata: null, count: resultCount }],
    requiresTable,
    inShape: [],
    outShape: [],
  };
}

const RECIPES = [
  recipe("oak_planks", 4, { oak_log: 1 }),
  recipe("stick", 4, { oak_planks: 2 }),
  recipe("oak_button", 1, { oak_planks: 1 }),
  recipe("crafting_table", 1, { oak_planks: 4 }),
  recipe("stone_pickaxe", 1, { cobblestone: 3, stick: 2 }, true),
  recipe("stone_axe", 1, { cobblestone: 3, stick: 2 }, true),
];

/**
 * A `botFixture` carrying `carried`, with a recipe table and a `craft` that
 * applies a recipe's delta to what it carries. `counts` is the live tally by
 * item id; the carried stacks are rebuilt from it after every craft.
 */
export function craftingBot(carried: Readonly<Record<string, number>>, tableAvailable = false) {
  const counts = new Map(
    Object.entries(carried).map(([name, count]) => {
      const item = craftingRegistry.itemsByName[name];
      assert.ok(item, `unknown test item ${name}`);
      return [item.id, count] as const;
    }),
  );
  const stacks: FakeStack[] = [];
  // Real stacks, split at the item's stack size, as the inventory window holds them.
  const restack = () =>
    stacks.splice(
      0,
      stacks.length,
      ...[...counts.entries()]
        .filter(([, count]) => count > 0)
        .flatMap(([id, count]) => {
          const stackSize = craftingRegistry.items[id].stackSize;
          return Array.from(
            { length: Math.ceil(count / stackSize) },
            (_, index) => new CraftItem(id, Math.min(stackSize, count - index * stackSize)) as unknown as FakeStack,
          );
        }),
    );
  restack();
  const craftCalls: string[] = [];
  const bot = botFixture(
    { items: stacks },
    {
      version: "1.21.4",
      currentWindow: null,
      closeWindow: () => undefined,
      findBlock: () => (tableAvailable ? { name: "crafting_table" } : null),
      recipesAll: (itemType: number, _metadata: number | null, craftingTable: boolean | object | null) =>
        RECIPES.filter(
          (candidate) => candidate.result.id === itemType && (!candidate.requiresTable || Boolean(craftingTable)),
        ),
      craft: async (selected: Recipe, applications: number) => {
        craftCalls.push(craftingRegistry.items[selected.result.id].name);
        for (const item of selected.delta) {
          counts.set(item.id, (counts.get(item.id) ?? 0) + item.count * applications);
        }
        restack();
      },
    },
  );
  return { bot, counts, craftCalls };
}
