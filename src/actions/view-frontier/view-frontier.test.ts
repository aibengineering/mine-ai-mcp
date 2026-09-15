import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { nearestFrontierQuery, SqlBotData, type BotStatusSnapshot } from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { sqlActionSource } from "../sql-action.js";
import { parseViewFrontierRequest } from "./contract.js";
import {
  determineAutoZoom,
  formatViewFrontierResult,
  frontierChunkExistsQuery,
  frontierMapBoundsQuery,
  frontierMapWindowQuery,
  viewFrontier,
} from "./view-frontier.js";

function dataFixture(t: TestContext): SqlBotData {
  const data = temporaryBotData({ botId: "cartographer", closeAfter: t });
  data.transaction((database) => {
    const insertChunk = database.prepare(`
      INSERT INTO frontier_chunks (
        chunk_key, dimension, chunk_x, chunk_z,
        first_observed_at, scanned_at, surface_water_fraction
      ) VALUES (?, 'overworld', ?, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:01.000Z', ?)
    `);
    const insertBiome = database.prepare(`
      INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count)
      VALUES (?, ?, ?)
    `);
    const insertMaterial = database.prepare(`
      INSERT INTO frontier_chunk_materials (chunk_key, material)
      VALUES (?, ?)
    `);
    const record = (chunkX: number, chunkZ: number, water: number, biomes: Array<[string, number]>) => {
      const key = `overworld|${chunkX}|${chunkZ}`;
      insertChunk.run(key, chunkX, chunkZ, water);
      for (const [biome, samples] of biomes) insertBiome.run(key, biome, samples);
      insertMaterial.run(key, chunkX === 1 ? "cactus" : "oak_log");
    };
    record(-1, -1, 0.8, [["forest", 64]]);
    record(0, 0, 0.2, [
      ["forest", 4],
      ["plains", 60],
    ]);
    record(1, 0, 0, [["desert", 64]]);
  });
  return data;
}

function botStatus(x: number, z: number): BotStatusSnapshot {
  return {
    botId: "cartographer",
    dimension: "overworld",
    x,
    y: 71.25,
    z,
    chunkX: Math.floor(x / 16),
    chunkZ: Math.floor(z / 16),
    yaw: 1.75,
    pitch: -0.25,
    health: 13,
    food: 9,
    gameMode: "survival",
    onGround: true,
    inWater: false,
    saturation: 2.5,
    timeOfDay: 6000,
    isSleeping: false,
    isRaining: false,
    inventory: [],
    updatedAt: "2026-08-21T07:00:00.000Z",
  };
}

test("renders a bot-centred biome map with a derived frontier boundary", (t) => {
  const data = dataFixture(t);

  const result = viewFrontier(
    data,
    botStatus(2.5, 3.5),
    parseViewFrontierRequest({ perspective: "biome", width: 5, height: 5, chunks_per_cell: 1 }),
  );

  assert.equal(
    result.map,
    [
      "biome | bot chunk 0,0 | 1 chunk(s)/cell",
      "chunks x -2..2, z -2..2 (east right, south down)",
      "nearest frontier: chunk 0,0 (7.1m, heading 129.3°)",
      "+-----+",
      "| ?   |",
      "|?B!? |",
      "| ?@A?|",
      "|  ?? |",
      "|     |",
      "+-----+",
    ].join("\n"),
  );
  assert.deepEqual(result.closestFrontier, {
    chunkX: 0,
    chunkZ: 0,
    distanceBlocks: 7.1,
    heading: 129.3,
  });
  assert.deepEqual(result.legend, [
    "@ = bot",
    "! = nearest unexplored frontier",
    "? = unobserved frontier",
    "blank = outside remembered map",
    "biome symbols = dominant sampled vertical biome",
    ". = observed chunk without a named biome",
    "A = desert",
    "B = forest",
    "C = plains",
  ]);
  const markdown = formatViewFrontierResult({
    status: "succeeded",
    view: result,
    source: sqlActionSource([
      frontierMapBoundsQuery,
      frontierMapWindowQuery,
      nearestFrontierQuery,
      frontierChunkExistsQuery,
    ]),
  });
  assert.match(markdown, /### biome map/);
  assert.match(markdown, /```text\nbiome \| bot chunk 0,0/);
  assert.match(markdown, /### Legend/);
  assert.deepEqual(data.read("SELECT bot_id, y, yaw, pitch, health, food, updated_at FROM bot_status"), [
    {
      bot_id: "cartographer",
      y: 71.25,
      yaw: 1.75,
      pitch: -0.25,
      health: 13,
      food: 9,
      updated_at: "2026-08-21T07:00:00.000Z",
    },
  ]);

  // The bot's own chunk is derived from its block position, and an unobserved
  // frontier inside that chunk is the nearest one.
  const fromBlock18 = viewFrontier(
    data,
    botStatus(18, 2),
    parseViewFrontierRequest({ perspective: "biome", width: 5, height: 5, chunks_per_cell: 1 }),
  );
  assert.deepEqual({ x: fromBlock18.center.chunkX, z: fromBlock18.center.chunkZ }, { x: 1, z: 0 });
  assert.deepEqual({ x: fromBlock18.closestFrontier?.chunkX, z: fromBlock18.closestFrontier?.chunkZ }, { x: 1, z: 0 });
});

test("renders one perspective, every perspective together, and zooms by aggregating aligned cells", (t) => {
  const data = dataFixture(t);

  const water = viewFrontier(
    data,
    botStatus(-1, -1),
    parseViewFrontierRequest({ perspective: "surface_water", width: 5, height: 5, chunks_per_cell: 2 }),
  );

  assert.deepEqual(water.window, {
    width: 5,
    height: 5,
    chunksPerCell: 2,
    minChunkX: -6,
    maxChunkX: 3,
    minChunkZ: -6,
    maxChunkZ: 3,
  });
  assert.match(water.map, /surface_water \| bot chunk -1,-1 \| 2 chunk\(s\)\/cell/);
  assert.match(water.map, /@/);
  assert.ok(water.legend.includes("W = 70%+ water"));

  const all = viewFrontier(
    data,
    botStatus(0, 0),
    parseViewFrontierRequest({ perspective: "all", width: 5, height: 5, chunks_per_cell: 1 }),
  );

  assert.equal(all.perspective, "all");
  assert.ok(all.maps);
  for (const perspective of ["biome", "surface_water"] as const) {
    assert.match(all.maps[perspective] ?? "", new RegExp(`${perspective} \\| bot chunk 0,0`), perspective);
    assert.ok(all.map.includes(`${perspective} | bot chunk 0,0`), perspective);
    assert.ok((all.legends?.[perspective]?.length ?? 0) > 0, perspective);
  }
});

test("auto-zooms when chunks_per_cell is omitted", (t) => {
  const data = dataFixture(t);

  // In dataFixture, chunks are at (-1,-1), (0,0), (1,0).
  // For width 5, height 5 (halfWidth=2, halfHeight=2), scale 1 fits maxSpan=1 <= 1*2.
  const scale1 = determineAutoZoom(data, "overworld", 0, 0, 5, 5);
  assert.equal(scale1, 1);

  // Add distant chunk at (20, 20)
  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES ('overworld|20|20', 'overworld', 20, 20, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:01.000Z', 0)`,
      )
      .run();
  });

  // Now maxSpan from (0,0) is 20.
  // With width 5, height 5 (halfWidth=2), scale needed is >= 20 / 2 = 10 -> scale 16.
  const scale16 = determineAutoZoom(data, "overworld", 0, 0, 5, 5);
  assert.equal(scale16, 16);

  // With default width 61, height 31 (halfWidth=30, halfHeight=15), scale 2 (2*15=30 >= 20) fits.
  const scaleDefault = determineAutoZoom(data, "overworld", 0, 0, 61, 31);
  assert.equal(scaleDefault, 2);
});

test("keeps the map request deliberately bounded", () => {
  assert.deepEqual(parseViewFrontierRequest({}), {
    perspective: "biome",
    width: 61,
    height: 31,
    chunksPerCell: undefined,
  });
  for (const input of [
    { width: 4 },
    { width: 6 },
    { width: 123 },
    { height: 83 },
    { chunks_per_cell: 3 },
    { perspective: "materials" },
    { surprise: true },
  ]) {
    assert.throws(() => parseViewFrontierRequest(input));
  }
});
