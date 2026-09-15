import assert from "node:assert/strict";
import test from "node:test";
import type { BotStatusSnapshot } from "./bot-status.js";
import { refreshNearestFrontier } from "./nearest-frontier.js";
import { temporaryBotData } from "../test-support/bot-data.js";

const status: BotStatusSnapshot = {
  botId: "navigator",
  dimension: "overworld",
  x: 0,
  y: 37.5,
  z: 0,
  chunkX: 0,
  chunkZ: 0,
  yaw: 1.25,
  pitch: -0.5,
  health: 11,
  food: 7,
  gameMode: "survival",
  onGround: true,
  inWater: false,
  saturation: 1,
  timeOfDay: 1000,
  isSleeping: false,
  isRaining: false,
  inventory: [],
  updatedAt: "2026-08-21T08:00:00.000Z",
};

test("refreshes the real bot status even when no frontier is known", (t) => {
  const data = temporaryBotData({ botId: "navigator", closeAfter: t });

  assert.equal(refreshNearestFrontier(data, status), null);
  assert.deepEqual(data.read("SELECT bot_id, x, y, z, yaw, pitch, health, food, updated_at FROM bot_status"), [
    {
      bot_id: "navigator",
      x: 0,
      y: 37.5,
      z: 0,
      yaw: 1.25,
      pitch: -0.5,
      health: 11,
      food: 7,
      updated_at: "2026-08-21T08:00:00.000Z",
    },
  ]);
});

test("returns one typed nearest target from the canonical frontier view", (t) => {
  const data = temporaryBotData({ botId: "navigator", closeAfter: t });
  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES ('overworld|1|0', 'overworld', 1, 0, ?, ?, 0)`,
      )
      .run("2026-08-21T07:59:00.000Z", "2026-08-21T07:59:01.000Z");
    database
      .prepare(
        `INSERT INTO bot_status (
          bot_id, dimension, game_mode, x, y, z, chunk_x, chunk_z, yaw, pitch, on_ground, in_water,
          health, food, saturation, time_of_day, is_sleeping, is_raining, updated_at
        ) VALUES ('other-bot', 'overworld', 'survival', 24, 64, 8, 1, 0, 0, 0, 1, 0, 20, 20, 5, 0, 0, 0, ?)`,
      )
      .run("2026-08-21T07:59:02.000Z");
  });

  // The other bot is standing at the frontier centre. The result must still
  // use navigator's status rather than choosing the globally shortest row.
  assert.deepEqual(refreshNearestFrontier(data, status), {
    chunkX: 1,
    chunkZ: 0,
    distanceBlocks: 25.3,
    heading: 108.4,
  });
});
