import assert from "node:assert/strict";
import test from "node:test";
import { readNotificationSummary, recordEvent, type BotEventInput } from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { formatReadRecentEventsResult, parseReadRecentEventsRequest, readRecentBotEvents, readRecentEvents } from "./index.js";

function playerMessage(
  summary: string,
  username = "Alex",
  direction: "incoming" | "outgoing" = "incoming",
): BotEventInput {
  return {
    type: "player_message",
    observedAt: "2026-08-23T00:00:00.000Z",
    summary,
    payload: { username, channel: "chat", direction, message: summary, addressed: false },
  };
}

test("formats incoming and outgoing message evidence", (t) => {
  assert.deepEqual(parseReadRecentEventsRequest(undefined), { limit: 50 });
  assert.deepEqual(parseReadRecentEventsRequest({ limit: 2 }), { limit: 2 });
  assert.throws(() => parseReadRecentEventsRequest({ limit: 0 }));
  assert.throws(() => parseReadRecentEventsRequest({ limit: 101 }));

  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", playerMessage("Can you bring wood?"));
  recordEvent(data, "MineAI", playerMessage("Yes, I can.", "MineAI", "outgoing"));

  // Which events a page holds and how the cursor moves is the next test's;
  // this one is what the model is shown of them.
  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.status, "succeeded");
  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player message/);
  assert.match(markdown, /Can you bring wood\?/);
  assert.match(markdown, /Direction: outgoing/);
  assert.match(markdown, /Remaining events:\*\* 0/);
});

test("reads all event directions oldest-first and advances the cursor atomically", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "collector", playerMessage("first"));
  recordEvent(data, "collector", playerMessage("collector replied", "collector", "outgoing"));
  recordEvent(data, "collector", playerMessage("third"));

  assert.deepEqual(readRecentEvents(data, "collector", 2), {
    events: [
      {
        eventId: 1,
        botId: "collector",
        type: "player_message",
        observedAt: "2026-08-23T00:00:00.000Z",
        summary: "first",
        payload: {
          username: "Alex",
          channel: "chat",
          direction: "incoming",
          message: "first",
          addressed: false,
        },
      },
      {
        eventId: 2,
        botId: "collector",
        type: "player_message",
        observedAt: "2026-08-23T00:00:00.000Z",
        summary: "collector replied",
        payload: {
          username: "collector",
          channel: "chat",
          direction: "outgoing",
          message: "collector replied",
          addressed: false,
        },
      },
    ],
    readThroughEventId: 2,
    remainingEventCount: 1,
  });
  assert.deepEqual(readNotificationSummary(data, "collector").recentPreview, ["third"]);

  data.transaction((database) => {
    database.exec(`
      CREATE TRIGGER refuse_event_cursor
      BEFORE UPDATE ON event_read_state
      BEGIN
        SELECT RAISE(ABORT, 'cursor refused');
      END
    `);
  });
  assert.throws(() => readRecentEvents(data, "collector", 1), /cursor refused/);
  assert.deepEqual(readNotificationSummary(data, "collector").recentPreview, ["third"]);

  data.transaction((database) => database.exec("DROP TRIGGER refuse_event_cursor"));
  assert.deepEqual(readRecentEvents(data, "collector", 100), {
    events: [
      {
        eventId: 3,
        botId: "collector",
        type: "player_message",
        observedAt: "2026-08-23T00:00:00.000Z",
        summary: "third",
        payload: {
          username: "Alex",
          channel: "chat",
          direction: "incoming",
          message: "third",
          addressed: false,
        },
      },
    ],
    readThroughEventId: 3,
    remainingEventCount: 0,
  });
  assert.deepEqual(readRecentEvents(data, "collector", 100), {
    events: [],
    readThroughEventId: 3,
    remainingEventCount: 0,
  });
  assert.deepEqual(readNotificationSummary(data, "collector"), { unreadCount: 0 });
});


test("returns and formats a player death lifecycle event through the existing event page", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T01:02:03.000Z",
    summary: "MineAI died at 12.5, 64, -3.25 in overworld.",
    payload: { dimension: "overworld", position: { x: 12.5, y: 64, z: -3.25 }, cause: null },
  });

  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.events[0]?.type, "player_death");
  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player death/);
  assert.match(markdown, /Observed: 2026-08-30T01:02:03.000Z/);
  assert.match(markdown, /Dimension: `overworld`/);
  assert.match(markdown, /Position: `12.5, 64, -3.25`/);
});
