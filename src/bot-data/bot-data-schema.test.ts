import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqlBotData } from "./sql-bot-data.js";
import { temporaryBotData } from "../test-support/bot-data.js";

const DICTIONARY =
  "SELECT database_name, table_name, column_name, description FROM data_dictionary ORDER BY table_name, column_name";

test("describes every queryable table and column, in the terms a model has to read them", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  const schemaObjects = data.read(`
    SELECT name AS table_name
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const describedObjects = data.read(`
    SELECT table_name
    FROM data_dictionary
    WHERE database_name = 'main' AND column_name IS NULL
    ORDER BY table_name
  `);

  assert.deepEqual(describedObjects, schemaObjects);

  const schemaColumns = data.read(`
    SELECT schema_object.name AS table_name, column_info.name AS column_name
    FROM sqlite_schema AS schema_object
    JOIN pragma_table_xinfo(schema_object.name) AS column_info
    WHERE schema_object.type IN ('table', 'view')
      AND schema_object.name NOT LIKE 'sqlite_%'
      AND column_info.hidden = 0
    ORDER BY schema_object.name, column_info.cid
  `);
  const describedColumns = data.read(`
    SELECT table_name, column_name
    FROM data_dictionary
    WHERE database_name = 'main' AND column_name IS NOT NULL
    ORDER BY table_name, column_name
  `);

  assert.deepEqual(
    describedColumns,
    [...schemaColumns].sort((left, right) =>
      `${String(left.table_name)}|${String(left.column_name)}`.localeCompare(
        `${String(right.table_name)}|${String(right.column_name)}`,
      ),
    ),
  );

  // Coverage alone would be satisfied by empty prose; a description has to say
  // what the value means, key format and unit included.
  assert.deepEqual(
    data.read(`
      SELECT table_name, column_name, description
      FROM data_dictionary
      WHERE database_name = 'main'
        AND table_name = 'frontier_chunks'
        AND column_name IN ('chunk_key', 'surface_water_fraction')
      ORDER BY column_name
    `),
    [
      {
        table_name: "frontier_chunks",
        column_name: "chunk_key",
        description: "Stable world-relative key formatted as dimension|chunk_x|chunk_z.",
      },
      {
        table_name: "frontier_chunks",
        column_name: "surface_water_fraction",
        description:
          "Fraction from 0.0 to 1.0 of the 256 horizontal cells whose highest non-air block is water or a bubble column.",
      },
    ],
  );
});

test("publishes compact map rows with a deterministic dominant biome", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, ?, 0, 0, ?, ?, 0)`,
      )
      .run("minecraft:overworld|0|0", "minecraft:overworld", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
    for (const [biome, samples] of [
      ["forest", 10],
      ["plains", 54],
    ] as const) {
      database
        .prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)")
        .run("minecraft:overworld|0|0", biome, samples);
    }
  });

  assert.deepEqual(data.read("SELECT chunk_x, dominant_biome, biomes FROM frontier_map_chunks"), [
    { chunk_x: 0, dominant_biome: "plains", biomes: "forest, plains" },
  ]);
});

test("rebuilds rather than duplicates the data dictionary when a persistent database reopens", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-bot-data-schema-"));
  const options = {
    storage: { kind: "persistent" as const, root },
    identity: { worldId: "dictionary-reopen-test", scope: { kind: "shared" as const } },
  };
  let data = SqlBotData.create(options);
  t.after(() => {
    data.close();
    rmSync(root, { recursive: true, force: true });
  });
  const expected = data.read(DICTIONARY);
  data.close();

  data = SqlBotData.create(options);
  assert.deepEqual(data.read(DICTIONARY), expected);
});
