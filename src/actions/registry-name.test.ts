import assert from "node:assert/strict";
import test from "node:test";
import { registryNameSchema } from "./registry-name.js";

// Every tool that takes an item or block name parses it through this one
// schema, so the spellings a model actually writes are proven here once rather
// than through each tool's parser.
test("a registry name accepts the spellings a model writes and refuses an empty one", () => {
  const cases: ReadonlyArray<readonly [input: string, expected: string | null]> = [
    ["cooked_beef", "cooked_beef"],
    ["Minecraft:Cooked Beef", "cooked_beef"],
    ["  OAK_LOG  ", "oak_log"],
    ["oak-planks", "oak_planks"],
    ["iron  - ingot", "iron_ingot"],
    ["", null],
    ["   ", null],
    ["minecraft:", null],
  ];
  for (const [input, expected] of cases) {
    const parsed = registryNameSchema.safeParse(input);
    assert.deepEqual(parsed.success ? parsed.data : null, expected, JSON.stringify(input));
  }
});
