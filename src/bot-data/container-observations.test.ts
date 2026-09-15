import assert from "node:assert/strict";
import test from "node:test";
import { forgetContainerObservation, recordContainerObservation } from "./container-observations.js";
import { temporaryBotData } from "../test-support/bot-data.js";

/** One complete look inside a container, as the observing bot reports it. */
const seen = (
  contents: readonly { slot: number; item: string; count: number }[],
  observedAt: string,
  blockName = "chest",
) => ({ blockName, slotCount: 27, contents, observedByBotId: "StorageBot", observedAt });

test("atomically replaces a complete container snapshot and exposes item rows", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const location = { dimension: "overworld", x: 4, y: 64, z: -2 };

  recordContainerObservation(data, {
    ...location,
    ...seen(
      [
        { slot: 0, item: "cobblestone", count: 12 },
        { slot: 8, item: "oak_log", count: 3 },
      ],
      "2026-08-24T00:00:00.000Z",
    ),
  });
  recordContainerObservation(data, {
    ...location,
    ...seen(
      [
        { slot: 2, item: "oak_log", count: 1 },
        { slot: 9, item: "oak_log", count: 2 },
      ],
      "2026-08-24T00:01:00.000Z",
    ),
  });

  assert.deepEqual(data.read("SELECT item_name, item_count, observed_at FROM observed_container_items"), [
    { item_name: "oak_log", item_count: 3, observed_at: "2026-08-24T00:01:00.000Z" },
  ]);
  assert.deepEqual(data.read("SELECT slot, item_name, item_count FROM observed_container_slots ORDER BY slot"), [
    { slot: 2, item_name: "oak_log", item_count: 1 },
    { slot: 9, item_name: "oak_log", item_count: 2 },
  ]);
  assert.deepEqual(data.read("SELECT contents_json FROM observed_containers"), [
    { contents_json: '[{"slot":2,"item":"oak_log","count":1},{"slot":9,"item":"oak_log","count":2}]' },
  ]);
});

test("represents an observed empty container and forgets a disproven location", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const location = { dimension: "overworld", x: 1, y: 2, z: 3 };
  const containers = () => data.read("SELECT COUNT(*) AS count FROM observed_containers")[0]?.count;

  recordContainerObservation(data, { ...location, ...seen([], "2026-08-24T00:00:00.000Z", "barrel") });

  assert.equal(containers(), 1);
  assert.equal(data.read("SELECT COUNT(*) AS count FROM observed_container_items")[0]?.count, 0);
  forgetContainerObservation(data, location);
  assert.equal(containers(), 0);
});

test("retains legacy item totals without inventing their unknown slots", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  data.transaction((database) => {
    database
      .prepare(
        `
        INSERT INTO observed_containers (
          container_key, dimension, block_x, block_y, block_z, block_name,
          slot_count, contents_json, observed_by_bot_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overworld|7|64|9",
        "overworld",
        7,
        64,
        9,
        "chest",
        27,
        '[{"item":"cobblestone","count":12}]',
        "StorageBot",
        "2026-08-23T00:00:00.000Z",
      );
  });

  assert.deepEqual(data.read("SELECT item_name, item_count FROM observed_container_items"), [
    { item_name: "cobblestone", item_count: 12 },
  ]);
  assert.deepEqual(data.read("SELECT slot, item_name, item_count FROM observed_container_slots"), []);
});
