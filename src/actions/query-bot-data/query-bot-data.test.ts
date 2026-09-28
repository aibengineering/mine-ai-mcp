import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { updateBotStatus } from "../../bot-data/bot-status.js";
import { installMinecraftKnowledge } from "../../bot-data/minecraft-knowledge.js";
import { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { queryBotDataCellSchema } from "./contract.js";
import { createQueryBotDataAction, formatQueryBotDataResult, queryBotData } from "./query-bot-data.js";
import { persistentBotData, temporaryBotData } from "../../test-support/bot-data.js";

const REGISTRY = {
  itemsArray: [{ id: 17, name: "oak_log", displayName: "Oak Log", stackSize: 64 }],
} as unknown as Bot["registry"];

test("queries bot data and Minecraft knowledge on one connection", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  installMinecraftKnowledge(data, REGISTRY);

  // The query connection is the writing connection: no snapshot sits between them.
  assert.deepEqual((await queryBotData(data, { sql: "SELECT COUNT(*) FROM main.frontier_chunks" })).rows, [[0]]);
  recordChunk(data, "oak_log");
  assert.deepEqual((await queryBotData(data, { sql: "SELECT COUNT(*) FROM main.frontier_chunks" })).rows, [[1]]);

  const joined = await queryBotData(data, {
    sql: `
      SELECT material.material, item.display_name
      FROM main.frontier_chunk_materials AS material
      JOIN knowledge.items AS item ON item.name = material.material
    `,
  });
  assert.deepEqual(joined, {
    columns: ["material", "display_name"],
    rows: [["oak_log", "Oak Log"]],
    returnedRows: 1,
    truncated: false,
  });
  assert.equal(
    formatQueryBotDataResult({ status: "succeeded", query: joined }),
    ["Returned **1** row.", "| material | display_name |", "| --- | --- |", "| oak_log | Oak Log |"].join("\n"),
  );

  const dictionary = await queryBotData(data, {
    sql: "SELECT database_name FROM data_dictionary WHERE table_name = 'frontier_chunks' AND column_name IS NULL",
  });
  assert.deepEqual(dictionary.rows, [["main"]]);

  const knowledgeDictionary = await queryBotData(data, {
    sql: `
      SELECT database_name, description
      FROM data_dictionary
      WHERE table_name = 'items' AND column_name = 'id'
    `,
  });
  assert.deepEqual(knowledgeDictionary.rows, [
    ["knowledge", "Runtime-derived INTEGER column; nested registry values are JSON text."],
  ]);

  const largeInteger = await queryBotData(data, { sql: "SELECT 9007199254740993 AS value" });
  assert.deepEqual(largeInteger.rows, [["9007199254740993"]]);
});

test("persistent queries use the same SqlBotData connection", async (t) => {
  const data = persistentBotData(t).open("world");
  installMinecraftKnowledge(data, REGISTRY);
  recordChunk(data, "oak_log");

  assert.deepEqual((await queryBotData(data, { sql: "SELECT material FROM main.frontier_chunk_materials" })).rows, [
    ["oak_log"],
  ]);
});

test("enforces statement, result, read-only, and pre-execution cancellation boundaries", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  installMinecraftKnowledge(data, REGISTRY);

  for (const invalidNumber of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => queryBotDataCellSchema.parse(invalidNumber), String(invalidNumber));
  }
  await assert.rejects(
    queryBotData(data, { sql: "PRAGMA table_list" }),
    /exactly one read-only SELECT or WITH statement/,
  );
  await assert.rejects(queryBotData(data, { sql: "SELECT 1; SELECT 2" }), /exactly one statement/);
  assert.throws(
    () => createQueryBotDataAction(data).parse({ sql: `SELECT 1${" ".repeat(16 * 1024)}` }),
    /at most 16384/,
  );
  await assert.rejects(queryBotData(data, { sql: "SELECT CAST('binary' AS BLOB)" }), /returned a BLOB/);
  await assert.rejects(queryBotData(data, { sql: "SELECT 1e999" }), /non-finite number/);
  await assert.rejects(
    queryBotData(data, {
      sql: "WITH value(material) AS (SELECT 'changed') UPDATE frontier_chunk_materials SET material = (SELECT material FROM value)",
    }),
    /only read-only SELECT and WITH statements are allowed/,
  );

  const bounded = await queryBotData(data, {
    sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 101) SELECT n FROM numbers",
  });
  assert.equal(bounded.returnedRows, 100);
  assert.equal(bounded.truncated, true);

  const byteBounded = await queryBotData(data, { sql: "SELECT printf('%70000s', 'x') AS oversized" });
  assert.deepEqual(byteBounded, {
    columns: ["oversized"],
    rows: [],
    returnedRows: 0,
    truncated: true,
  });

  const controller = new AbortController();
  controller.abort(new Error("operator cancelled query"));
  await assert.rejects(queryBotData(data, { sql: "SELECT 1" }, controller.signal), /operator cancelled query/);
});

test("queries bot_status and joins with frontier chunks to calculate distances", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordChunk(data, "oak_log");
  updateBotStatus(data, {
    botId: "bot1",
    dimension: "minecraft:overworld",
    x: 0,
    y: 64,
    z: 0,
    chunkX: 0,
    chunkZ: 0,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    gameMode: "survival",
    onGround: true,
    inWater: false,
    saturation: 5,
    timeOfDay: 0,
    isSleeping: false,
    isRaining: false,
    inventory: [],
  });

  const query = await queryBotData(data, {
    sql: `
      SELECT
        c.chunk_x,
        c.chunk_z,
        round(sqrt(pow((c.chunk_x - s.chunk_x) * 16, 2) + pow((c.chunk_z - s.chunk_z) * 16, 2)), 1) AS distance
      FROM main.frontier_chunks AS c
      CROSS JOIN main.bot_status AS s
      WHERE s.bot_id = 'bot1'
    `,
  });

  assert.deepEqual(query.rows, [[1, 2, 35.8]]);
});

function recordChunk(data: SqlBotData, material: string): void {
  const key = "minecraft:overworld|1|2";
  data.transaction((database) => {
    database
      .prepare(
        `
        INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, 'minecraft:overworld', 1, 2, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 0)
      `,
      )
      .run(key);
    database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)").run(key, material);
  });
}
