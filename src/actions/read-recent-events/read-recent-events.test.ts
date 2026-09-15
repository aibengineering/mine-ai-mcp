import assert from "node:assert/strict";
import test from "node:test";
import {
  readNotificationSummary,
  recordEvent,
  type BotEvent,
  type BotEventInput,
  type SqlBotData,
} from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { DEFAULT_COMBAT_POLICY } from "../../survival/policy/combat/contract.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { botFixture } from "../../test-support/bot.js";
import { botEventInputSchema } from "../../bot-data/event-log.js";
import { formatReadRecentEventsResult, parseReadRecentEventsRequest, readRecentBotEvents } from "./index.js";

/** Historical records stay readable; production only writes the new receipts. */
function historicalEvent(data: SqlBotData, event: Omit<BotEvent, "eventId" | "botId">): void {
  data.transaction((database) =>
    database
      .prepare("INSERT INTO events (bot_id, event_type, observed_at, summary, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run("MineAI", event.type, event.observedAt, event.summary, JSON.stringify(event.payload)),
  );
}

test("old combat policies and new survival policies share a readable advancing event cursor", () => {
  using data = temporaryBotData();
  const override = { changes: { bow: false }, lifetime: { kind: "session" as const } };
  for (const legacyOverride of [null, override]) {
    const event = {
      type: "combat_policy" as const, observedAt: "2026-09-11T00:00:00.000Z", summary: "Historical policy",
      payload: { revision: "old:1", defaults: DEFAULT_COMBAT_POLICY,
        effective: { ...DEFAULT_COMBAT_POLICY, bow: legacyOverride === null },
        override: legacyOverride, encounter: null, response: null, settling: false,
        lastChange: "Model replaced the policy override.", constraint: null },
    };
    historicalEvent(data, event);
    assert.equal(botEventInputSchema.safeParse(event).success, false, "old events remain read-only");
  }
  const policy = new SurvivalPolicyState(botFixture()).snapshot();
  historicalEvent(data, { type: "survival_policy", observedAt: "2026-09-12T00:00:00.000Z", summary: "Current policy", payload: policy });
  const first = readRecentBotEvents(data, "MineAI", { limit: 2 });
  assert.deepEqual(first.events.map((event) => event.type), ["combat_policy", "combat_policy"]);
  assert.equal(first.remainingEventCount, 1);
  assert.match(formatReadRecentEventsResult(first), /combat policy \(historical\)/);
  assert.match(formatReadRecentEventsResult(first), /"bow":false/);
  const second = readRecentBotEvents(data, "MineAI", { limit: 2 });
  assert.deepEqual(second.events.map((event) => event.type), ["survival_policy"]);
  assert.equal(second.readThroughEventId, 3);
  assert.equal(second.remainingEventCount, 0);
  assert.match(formatReadRecentEventsResult(second), /survival policy/);
  assert.equal(readRecentBotEvents(data, "MineAI", { limit: 2 }).events.length, 0);
});

/**
 * A reflex that did not achieve its purpose must read as the attempt it was.
 * Each row is a historical payload whose rendering must not overstate recovery.
 */
const reflexRows: ReadonlyArray<{
  name: string;
  event: Omit<BotEvent, "eventId" | "botId">;
  matches: RegExp[];
  doesNotMatch: RegExp[];
}> = [
  {
    name: "a fire escape the bot could not complete",
    event: {
      type: "fire_reflex" as const,
      observedAt: "2026-09-07T07:00:00.000Z",
      summary: "Fire escape blocked",
      payload: {
        outcome: "blocked",
        healthBefore: 20,
        healthAfter: 16,
        interrupted: { action: "collect_block", startedAt: "2026-09-07T06:59:00.000Z" },
      },
    },
    matches: [/Outcome: blocked/, /Health: 20 → 16/, /collect_block/],
    doesNotMatch: [/Outcome: escaped/],
  },
  {
    name: "a breath attempt with zero observed recovery",
    event: {
      type: "breath_reflex" as const,
      observedAt: "2026-09-05T03:46:00.000Z",
      summary: "MineAI could not reach air; air 0 → 0.",
      payload: { airBefore: 0, airAfter: 0, healthBefore: 20, healthAfter: 20, dug: 0, interrupted: null },
    },
    matches: [/surfacing attempt/, /could not reach air/],
    doesNotMatch: [/surfaced for air/],
  },
];

test("a reflex that did not recover is reported as an attempt, never as a rescue", () => {
  for (const row of reflexRows) {
    using data = temporaryBotData();
    historicalEvent(data, row.event);
    const markdown = formatReadRecentEventsResult(readRecentBotEvents(data, "MineAI", { limit: 50 }));
    for (const pattern of row.matches) assert.match(markdown, pattern, row.name);
    for (const pattern of row.doesNotMatch) assert.doesNotMatch(markdown, pattern, row.name);
  }
});

function messageEvent(message: string, direction: "incoming" | "outgoing" = "incoming"): BotEventInput {
  const username = direction === "incoming" ? "Alex" : "MineAI";
  return {
    type: "player_message",
    observedAt: "2026-08-23T01:00:00.000Z",
    summary: `${username}: ${message}`,
    payload: { username, channel: "chat", direction, message, addressed: direction === "incoming" },
  };
}

test("returns incoming and outgoing events, advances the cursor, and formats their evidence", (t) => {
  assert.deepEqual(parseReadRecentEventsRequest(undefined), { limit: 50 });
  assert.deepEqual(parseReadRecentEventsRequest({ limit: 2 }), { limit: 2 });
  assert.throws(() => parseReadRecentEventsRequest({ limit: 0 }));
  assert.throws(() => parseReadRecentEventsRequest({ limit: 101 }));

  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", messageEvent("Can you bring wood?"));
  recordEvent(data, "MineAI", messageEvent("Yes, I can.", "outgoing"));

  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.events.map((event) => (event.type === "player_message" ? event.payload.direction : event.type)),
    ["incoming", "outgoing"],
  );
  assert.equal(result.readThroughEventId, 2);
  assert.equal(result.remainingEventCount, 0);

  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player message/);
  assert.match(markdown, /Can you bring wood\?/);
  assert.match(markdown, /Direction: outgoing/);
  assert.match(markdown, /Remaining events:\*\* 0/);
  assert.deepEqual(readNotificationSummary(data, "MineAI"), { unreadCount: 0 });
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
