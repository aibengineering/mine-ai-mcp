import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Bot } from "mineflayer";
import { attachMinecraftKnowledge } from "./minecraft-knowledge.js";

function connectedRegistryFixture(): Bot["registry"] {
  return {
    version: { minecraftVersion: "1.21.4", version: 769, dataVersion: 4189, ">=": () => true },
    itemsArray: [
      { id: 3, name: "oak_log", displayName: "Oak Log", stackSize: 64 },
      { id: 4, name: "oak_planks", displayName: "Oak Planks", stackSize: 64 },
    ],
    blocksArray: [
      {
        id: 11,
        name: "oak_log",
        displayName: "Oak Log",
        hardness: 2,
        diggable: true,
        drops: [3],
      },
    ],
    biomesArray: [{ id: 1, name: "plains", color: 9_288_832, rainfall: 0.4 }],
    biomes: [{ id: 1, name: "plains", color: 9_288_832, rainfall: 0.4 }],
    entitiesArray: [{ id: 28, name: "cow", displayName: "Cow", type: "animal", width: 0.9, height: 1.4 }],
    recipes: {
      4: [{ ingredients: [3], result: { id: 4, count: 4 } }],
    },
  } as unknown as Bot["registry"];
}

test("attaches all derived data as queryable strict tables", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  attachMinecraftKnowledge(database, connectedRegistryFixture());

  assert.deepEqual(
    database
      .prepare(
        `
        SELECT block.name, json_extract(block.drops, '$[0]') AS dropped_item_id, item.display_name
        FROM knowledge.blocks AS block
        JOIN knowledge.items AS item ON item.id = json_extract(block.drops, '$[0]')
      `,
      )
      .all()
      .map((row) => ({ ...row })),
    [{ name: "oak_log", dropped_item_id: 3, display_name: "Oak Log" }],
  );
  assert.deepEqual(
    database
      .prepare("SELECT result_item_id, json_extract(result, '$.count') AS count FROM knowledge.recipes")
      .all()
      .map((row) => ({ ...row })),
    [{ result_item_id: 4, count: 4 }],
  );
  assert.deepEqual(
    database
      .prepare("PRAGMA knowledge.table_info('biomes')")
      .all()
      .map((row) => ({ name: row.name, type: row.type })),
    [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
      { name: "color", type: "INTEGER" },
      { name: "rainfall", type: "REAL" },
    ],
  );
});

test("rolls back and detaches a knowledge database that cannot be populated", (t) => {
  const unusableRegistry = new DatabaseSync(":memory:");
  const unwritableDatabase = new DatabaseSync(":memory:");
  t.after(() => {
    unusableRegistry.close();
    unwritableDatabase.close();
  });
  unwritableDatabase.exec("PRAGMA query_only = ON");

  assert.throws(
    () => attachMinecraftKnowledge(unusableRegistry, { brokenArray: [{}] } as unknown as Bot["registry"]),
    /must have at least one column/i,
  );
  assert.throws(() => attachMinecraftKnowledge(unwritableDatabase, connectedRegistryFixture()), /readonly|read-only/i);
  // A half-built attachment would leave later queries reading missing tables,
  // whether population failed on the registry or before its transaction began.
  for (const database of [unusableRegistry, unwritableDatabase]) {
    assert.equal(database.prepare("SELECT 1 FROM pragma_database_list WHERE name = 'knowledge'").get(), undefined);
  }
});
