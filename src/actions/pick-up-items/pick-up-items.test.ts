import assert from "node:assert/strict";
import test from "node:test";
import { recordLastDeath } from "../../bot-data/index.js";
import { botFixture } from "../../test-support/bot.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { createPickUpItemsAction } from "./pick-up-items.js";

test("death recovery returns its named no-record refusal with schema-valid current position", async (t) => {
  const bot = botFixture();
  const data = temporaryBotData({ closeAfter: t });
  const action = createPickUpItemsAction(bot, {} as never, data, createDiscardedItems());
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /NO_RECORDED_DEATH/);
  assert.deepEqual(result.pickup.center, {
    x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
  });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});

test("death recovery refuses another dimension before asking navigation to move", async (t) => {
  const bot = botFixture();
  const data = temporaryBotData({ closeAfter: t });
  recordLastDeath(data, {
    botId: bot.username,
    dimension: "the_nether",
    position: { x: 30.5, y: 70, z: -4.5 },
    observedAt: new Date().toISOString(),
    cause: "fell from a high place",
  });
  let navigated = false;
  const action = createPickUpItemsAction(
    bot, { navigate: async () => { navigated = true; return { status: "completed", elapsedMs: 0 }; } } as never,
    data, createDiscardedItems(),
  );
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.equal(navigated, false);
  assert.match("error" in result ? result.error : "", /DEATH_DIMENSION_MISMATCH/);
  assert.deepEqual(result.pickup.center, { x: 30.5, y: 70, z: -4.5 });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});

test("stale death refusal preserves the retained recovery facts", async (t) => {
  const bot = botFixture();
  const data = temporaryBotData({ closeAfter: t });
  recordLastDeath(data, {
    botId: bot.username,
    dimension: bot.game.dimension,
    position: { x: 12.5, y: 64, z: 8.5 },
    observedAt: new Date(Date.now() - 301_000).toISOString(),
    cause: null,
  });
  const action = createPickUpItemsAction(bot, {} as never, data, createDiscardedItems());
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.match("error" in result ? result.error : "", /DEATH_RECORD_STALE/);
  assert.equal(result.pickup.recovery?.dimension, bot.game.dimension);
  assert.deepEqual(result.pickup.center, { x: 12.5, y: 64, z: 8.5 });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});
