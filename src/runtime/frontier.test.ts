import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { SqlBotData } from "../bot-data/index.js";
import { attachSessionFrontier } from "./frontier.js";

function temporaryBotData(): SqlBotData {
  return SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "frontier-test", scope: { kind: "shared" } },
  });
}

function fixture(surfaceWaterCells = 129) {
  const events = new EventEmitter();
  const column = {
    sections: [
      { data: { palette: [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], get: () => 0 } },
      { data: { value: 0, get: () => 0 } },
      { data: { get: (index: number) => (index === 20 ? 8 : 0) } },
      {
        data: {
          palette: [0, 1, 9],
          get: (index: number) => {
            const y = index >> 8;
            const horizontalIndex = index & 0xff;
            if (y === 15 && horizontalIndex < surfaceWaterCells) return 9;
            return y === 14 ? 1 : 0;
          },
        },
      },
      { data: { value: 0, get: () => 0 } },
    ],
    biomes: [{ data: { palette: [1, 2], get: (index: number) => (index < 16 ? 2 : 1) } }],
  };
  const columns = [{ chunkX: -2, chunkZ: 4, column }];
  const bot = Object.assign(events, {
    game: { dimension: "overworld" },
    entities: {},
    world: { getColumns: () => columns, getColumn: () => column },
    registry: {
      blocksByStateId: {
        0: { name: "air" },
        1: { name: "stone" },
        2: { name: "oak_log" },
        3: { name: "prismarine" },
        4: { name: "coal_ore" },
        5: { name: "diamond_ore" },
        6: { name: "oak_log" },
        8: { name: "ancient_debris" },
        9: { name: "water" },
        10: { name: "gravel" },
        11: { name: "copper_ore" },
        12: { name: "deepslate_copper_ore" },
        13: { name: "gold_ore" },
        14: { name: "deepslate_gold_ore" },
        15: { name: "redstone_ore" },
        16: { name: "deepslate_redstone_ore" },
        17: { name: "lapis_ore" },
        18: { name: "deepslate_lapis_ore" },
        19: { name: "deepslate_diamond_ore" },
      },
      biomes: {
        1: { name: "plains" },
        2: { name: "forest" },
      },
    },
  }) as unknown as Bot;
  const data = temporaryBotData();
  return { events, bot, column, data };
}

test("records useful materials and counted biomes once for each loaded chunk", async (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });

  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  await frontier.idle();

  assert.deepEqual(
    data.read("SELECT chunk_key, dimension, chunk_x, chunk_z FROM frontier_chunks ORDER BY chunk_x, chunk_z"),
    [
      { chunk_key: "overworld|-2|4", dimension: "overworld", chunk_x: -2, chunk_z: 4 },
      { chunk_key: "overworld|3|-2", dimension: "overworld", chunk_x: 3, chunk_z: -2 },
    ],
  );
  assert.deepEqual(frontier.status(), {
    observedChunks: 2,
    pendingChunks: 0,
    error: null,
  });
  assert.deepEqual(recorded, [
    { dimension: "overworld", chunkX: -2, chunkZ: 4 },
    { dimension: "overworld", chunkX: 3, chunkZ: -2 },
  ]);
  assert.equal(frontier.boundary("overworld", { x: 1, z: 0 }), 3);
  assert.equal(frontier.boundary("overworld", { x: 0, z: -1 }), 2);
  assert.equal(frontier.boundary("the_nether", { x: 1, z: 0 }), null);
  assert.deepEqual(data.read("SELECT DISTINCT material FROM frontier_chunk_materials ORDER BY material"), [
    { material: "ancient_debris" },
    { material: "diamond_ore" },
    { material: "oak_log" },
    { material: "prismarine" },
  ]);
  assert.deepEqual(
    data.read(`
      SELECT c.chunk_x, c.chunk_z
      FROM frontier_chunks AS c
      JOIN frontier_chunk_materials AS m USING (chunk_key)
      WHERE m.material = 'oak_log'
      ORDER BY c.chunk_x, c.chunk_z
    `),
    [
      { chunk_x: -2, chunk_z: 4 },
      { chunk_x: 3, chunk_z: -2 },
    ],
  );
  assert.deepEqual(data.read("SELECT DISTINCT biome FROM frontier_chunk_biomes ORDER BY biome"), [
    { biome: "forest" },
    { biome: "plains" },
  ]);
  assert.deepEqual(
    data.read(
      "SELECT biome, sample_count FROM frontier_chunk_biomes WHERE chunk_key = 'overworld|3|-2' ORDER BY biome",
    ),
    [
      { biome: "forest", sample_count: 16 },
      { biome: "plains", sample_count: 48 },
    ],
  );
  const enrichment = data.read(`
    SELECT scanned_at, surface_water_fraction
    FROM frontier_chunks
    WHERE chunk_x = 3 AND chunk_z = -2
  `)[0];
  assert.equal(typeof enrichment?.scanned_at, "string");
  assert.equal(enrichment?.surface_water_fraction, 129 / 256);
});

test("clears a chunk's frontier flag once all four neighbours are recorded", async (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  events.emit("chunkColumnLoad", new Vec3(-32, 0, 48));
  events.emit("chunkColumnLoad", new Vec3(-16, 0, 64));
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 80));
  events.emit("chunkColumnLoad", new Vec3(-48, 0, 64));
  await frontier.idle();

  assert.deepEqual(
    data.read(`
      SELECT chunk_x, chunk_z, is_frontier
      FROM frontier_chunks
      ORDER BY chunk_z, chunk_x
    `),
    [
      { chunk_x: -2, chunk_z: 3, is_frontier: 1 },
      { chunk_x: -3, chunk_z: 4, is_frontier: 1 },
      { chunk_x: -2, chunk_z: 4, is_frontier: 0 },
      { chunk_x: -1, chunk_z: 4, is_frontier: 1 },
      { chunk_x: -2, chunk_z: 5, is_frontier: 1 },
    ],
  );
});

test("reports only chunks committed by this session observer", async (t) => {
  const { bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  const unsubscribe = frontier.onRecorded((chunk) => recorded.push(chunk));
  data.transaction((database) => {
    database
      .prepare(
        `
        INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overworld|20|20", "overworld", 20, 20, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.001Z", 0);
  });

  assert.deepEqual(recorded, []);
  assert.equal(frontier.boundary("overworld", { x: 1, z: 0 }), 20);
  unsubscribe();
});

test("a recorded-chunk listener cannot poison frontier health or later listeners", async (t) => {
  const { bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  frontier.onRecorded(() => {
    throw new Error("broken consumer");
  });
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.deepEqual(frontier.status(), { observedChunks: 1, pendingChunks: 0, error: null });
  assert.deepEqual(recorded, [{ dimension: "overworld", chunkX: -2, chunkZ: 4 }]);
});

test("rejects a chunk key that does not match its dimension and coordinates", (t) => {
  const data = temporaryBotData();
  t.after(() => data.close());

  assert.throws(
    () =>
      data.transaction((database) => {
        database
          .prepare(
            `
            INSERT INTO frontier_chunks (
              chunk_key, dimension, chunk_x, chunk_z,
              first_observed_at, scanned_at, surface_water_fraction
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run("wrong", "overworld", 3, -2, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.001Z", 0.5);
      }),
    /CHECK constraint failed/,
  );
});

test("records exact surface water coverage rather than only a majority", async (t) => {
  const { bot, data } = fixture(128);
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(data.read("SELECT surface_water_fraction FROM frontier_chunks")[0]?.surface_water_fraction, 0.5);
});

test("does not persist a partial chunk when scanning fails", async (t) => {
  const { bot, column, data } = fixture();
  column.sections[2]!.data.get = () => {
    throw new Error("broken chunk palette");
  };
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count, 0);
  assert.match(frontier.status().error ?? "", /broken chunk palette/);
});

test("does not scan an enriched chunk again when it reloads", async (t) => {
  const { events, bot, column, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  column.sections[0]!.data.palette!.push(7);
  (bot.registry.blocksByStateId as Record<number, { name: string }>)[7] = { name: "birch_log" };
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 64));
  await frontier.idle();

  assert.deepEqual(data.read("SELECT material FROM frontier_chunk_materials ORDER BY material"), [
    { material: "ancient_debris" },
    { material: "diamond_ore" },
    { material: "oak_log" },
    { material: "prismarine" },
  ]);
});

test("coalesces repeated chunk loads before scanning", async (t) => {
  const { events, bot, column, data } = fixture();
  let directPaletteReads = 0;
  column.sections[2]!.data.get = (index: number) => {
    directPaletteReads += 1;
    return index === 20 ? 8 : 0;
  };
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  await frontier.idle();

  assert.equal(directPaletteReads, 4096 * 2);
});

test("stops recording when the session frontier closes", (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    data.close();
  });

  frontier.close();
  events.emit("chunkColumnLoad", new Vec3(16, 0, 16));

  assert.equal(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count, 0);
});
