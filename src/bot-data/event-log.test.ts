import assert from "node:assert/strict";
import test from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { persistentBotData, temporaryBotData } from "../test-support/bot-data.js";
import { readNotificationSummary, recordEvent, type BotEventInput } from "./event-log.js";

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

/** A store on disk that this test writes, closes, and reopens under the same identity. */
test("events and their cursors survive a restart", (t) => {
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
});
