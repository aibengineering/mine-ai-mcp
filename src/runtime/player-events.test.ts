import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { botEventInputSchema, readLastDeath, readNotificationSummary, SqlBotData } from "../bot-data/index.js";
import { observePlayerEvents } from "./player-events.js";

function playerBot(username = "MineAI"): Bot {
  return Object.assign(new EventEmitter(), {
    username,
    game: { dimension: "overworld" },
    entities: {},
    entity: { position: { x: 12.5, y: 64, z: -3.25 } },
  }) as unknown as Bot;
}

test("records incoming and outgoing player messages while notifying only for incoming ones", (t) => {
  const bot = playerBot();
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-message-test", scope: { kind: "bot", botId: bot.username } },
  });
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(() => {
    stopObserving();
    data.close();
  });

  bot.emit("chat", "Alex", "MineAI, can you bring wood?", null, {} as never, null);
  bot.emit("chat", "MineAI", "Yes, I can.", null, {} as never, null);
  bot.emit("whisper", "Steve", "meet me at spawn", null, {} as never, null);

  assert.deepEqual(readNotificationSummary(data, bot.username), {
    unreadCount: 2,
    recentPreview: ["Alex: MineAI, can you bring wood?", "Steve: meet me at spawn"],
    hint: "Use read_recent_events to read and advance through recent events.",
  });

  const result = readRecentEvents(data, bot.username, 50);
  assert.deepEqual(
    result.events.map(({ summary, payload }) => ({ summary, payload })),
    [
      {
        summary: "Alex: MineAI, can you bring wood?",
        payload: {
          username: "Alex",
          channel: "chat",
          direction: "incoming",
          message: "MineAI, can you bring wood?",
          addressed: true,
        },
      },
      {
        summary: "MineAI: Yes, I can.",
        payload: {
          username: "MineAI",
          channel: "chat",
          direction: "outgoing",
          message: "Yes, I can.",
          addressed: false,
        },
      },
      {
        summary: "Steve: meet me at spawn",
        payload: {
          username: "Steve",
          channel: "whisper",
          direction: "incoming",
          message: "meet me at spawn",
          addressed: false,
        },
      },
    ],
  );
  assert.deepEqual(readNotificationSummary(data, bot.username), { unreadCount: 0 });

  stopObserving();
  stopObserving();
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
  assert.equal(bot.listenerCount("death"), 0);
  bot.emit("chat", "Alex", "after close", null, {} as never, null);
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);
});

test("the player death event requires a finite exact position", () => {
  const event = {
    type: "player_death",
    observedAt: "2026-08-30T00:00:00.000Z",
    summary: "RuntimeBot died.",
    payload: { dimension: "overworld", position: { x: 12.5, y: 64, z: -3.25 }, cause: null },
  };

  assert.deepEqual(botEventInputSchema.parse(event), event);
  for (const invalidCoordinate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() =>
      botEventInputSchema.parse({
        ...event,
        payload: { ...event.payload, position: { ...event.payload.position, x: invalidCoordinate } },
      }),
    );
  }
});

test("death requests cancellation once, records one event, and detaches without touching other listeners", (t) => {
  const bot = playerBot("RuntimeBot");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-death-test", scope: { kind: "bot", botId: bot.username } },
  });
  const cancellations: string[] = [];
  let unrelatedDeaths = 0;
  const unrelatedListener = () => {
    unrelatedDeaths += 1;
  };
  bot.on("death", unrelatedListener);
  const stopObserving = observePlayerEvents(bot, data, (reason) => {
    cancellations.push(reason);
    bot.entity.position.x = 99;
    return { kind: "idle", reason };
  });
  t.after(() => {
    stopObserving();
    data.close();
  });

  bot.emit("death");

  assert.deepEqual(cancellations, ["RuntimeBot died."]);
  assert.equal(unrelatedDeaths, 1);
  assert.deepEqual(readNotificationSummary(data, bot.username), {
    unreadCount: 1,
    recentPreview: ["RuntimeBot died at 12.5, 64, -3.25 in ov..."],
    hint: "Use read_recent_events to read and advance through recent events.",
  });
  const page = readRecentEvents(data, bot.username, 50);
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0]?.payload, {
    dimension: "overworld",
    position: { x: 12.5, y: 64, z: -3.25 },
    cause: null,
  });
  assert.deepEqual(readLastDeath(data, bot.username), {
    botId: "RuntimeBot", dimension: "overworld",
    position: { x: 12.5, y: 64, z: -3.25 },
    observedAt: page.events[0]!.observedAt, cause: null,
  });

  stopObserving();
  stopObserving();
  assert.equal(bot.listenerCount("death"), 1);
  bot.emit("death");
  assert.equal(unrelatedDeaths, 2);
  assert.deepEqual(cancellations, ["RuntimeBot died."]);
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);
});

test("a respawn into another dimension records one event; a respawn in the same dimension records none", () => {
  const bot = playerBot("RuntimeBot");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-dimension-test", scope: { kind: "bot", botId: bot.username } },
  });
  const stopObserving = observePlayerEvents(bot, data, () => undefined);

  bot.emit("respawn");
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);

  bot.game.dimension = "the_nether";
  bot.emit("respawn");
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0, "respawn still has departure coordinates");
  Object.assign(bot.entity.position, { x: 18.5, y: 56, z: 26.5 });
  bot.emit("forcedMove");
  const events = readRecentEvents(data, bot.username, 50).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "player_dimension_change");
  assert.equal(events[0]?.summary, "RuntimeBot arrived in the_nether from overworld.");
  if (events[0]?.type === "player_dimension_change") {
    assert.deepEqual(events[0].payload, {
      from: "overworld",
      to: "the_nether",
      position: { x: 18.5, y: 56, z: 26.5 },
    });
  }

  stopObserving();
  assert.equal(bot.listenerCount("respawn"), 0);
  assert.equal(bot.listenerCount("forcedMove"), 0);
  data.close();
});
