import assert from "node:assert/strict";
import test from "node:test";
import { readNotificationSummary, recordEvent, type BotEventInput } from "../../bot-data/index.js";
import { readRecentEvents } from "./read-recent-events.js";
import { persistentBotData, temporaryBotData } from "../../test-support/bot-data.js";

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

test("notification policy selects only incoming messages beyond this bot's cursor", (t) => {
  const data = temporaryBotData();
  t.after(() => data.close());

  recordEvent(data, "collector", playerMessage("first"));
  recordEvent(data, "builder", playerMessage("not for collector", "Builder"));
  recordEvent(data, "collector", playerMessage("collector replied", "collector", "outgoing"));
  recordEvent(data, "collector", playerMessage("second"));
  recordEvent(data, "collector", playerMessage("third"));
  recordEvent(data, "collector", playerMessage("a summary long enough to require a deliberately visible truncation"));

  assert.deepEqual(readNotificationSummary(data, "collector"), {
    unreadCount: 4,
    recentPreview: ["second", "third", "a summary long enough to require a delib..."],
    hint: "Use read_recent_events to read and advance through recent events.",
  });
  assert.deepEqual(readNotificationSummary(data, "builder"), {
    unreadCount: 1,
    recentPreview: ["not for collector"],
    hint: "Use read_recent_events to read and advance through recent events.",
  });
});

test("reads all event directions oldest-first and advances the cursor atomically", (t) => {
  const data = temporaryBotData();
  t.after(() => data.close());
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

/** A store on disk that this test writes, closes, and reopens under the same identity. */

test("events and their cursors survive a restart, including one predating the event-reader table name", (t) => {
  const storage = persistentBotData(t);
  const open = () => storage.open("world");
  const first = open();
  recordEvent(first, "collector", playerMessage("persisted"));
  readRecentEvents(first, "collector", 50);
  first.close();

  const reopened = open();
  assert.deepEqual(readNotificationSummary(reopened, "collector"), { unreadCount: 0 });
  const next = recordEvent(reopened, "collector", playerMessage("after restart"));
  assert.equal(next.eventId, 2, "event ids continue rather than restart");
  assert.deepEqual(readNotificationSummary(reopened, "collector").recentPreview, ["after restart"]);
  reopened.close();

  const migration = persistentBotData(t);
  const openOld = () => migration.open("world");
  const beforeRename = openOld();
  recordEvent(beforeRename, "collector", playerMessage("already read"));
  recordEvent(beforeRename, "collector", playerMessage("still unread"));
  readRecentEvents(beforeRename, "collector", 1);
  beforeRename.transaction((database) => database.exec("ALTER TABLE event_read_state RENAME TO notification_state"));
  beforeRename.close();

  const migrated = openOld();
  assert.deepEqual(readNotificationSummary(migrated, "collector").recentPreview, ["still unread"]);
  assert.deepEqual(
    migrated.read("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%read_state' ORDER BY name"),
    [{ name: "event_read_state" }],
  );
});
