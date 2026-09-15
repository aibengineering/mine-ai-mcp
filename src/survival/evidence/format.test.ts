import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SURVIVAL_POLICY } from "../policy/contract.js";
import { survivalStatusSchema, type SurvivalStatus, type SurvivalReceipt } from "./contract.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { readNotificationSummary, recordEvent } from "../../bot-data/event-log.js";
import { readRecentEvents } from "../../actions/read-recent-events/read-recent-events.js";
import { formatSurvivalOutcome, formatSurvivalStatus } from "./format.js";

function snapshot(): SurvivalStatus {
  return {
    summary: "unknown",
    request: { id: "request-id", requestId: 1, action: "smelt_item", admittedAt: 1,
      objective: { itemName: "mutton", count: 23 }, state: { kind: "returned" }, evidence: null },
    owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: [],
    observations: { missing: ["own_air_metadata"], stale: [] },
    policy: { revision: "revision-id", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY,
      overrides: [], encounter: null, response: null, settling: false, lastChange: "Default policy.", constraint: null },
    vitals: { health: 20, food: 16, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 1234, physicsObservedAt: 1233 },
  };
}

test("ordinary replies omit diagnostics without losing them from JSON", () => {
  const status = snapshot();
  const before = structuredClone(status);
  assert.equal(formatSurvivalStatus(status), "**Vitals:** Health 20/20; hunger 16/20.");
  assert.deepEqual(survivalStatusSchema.parse(status), before);
  status.vitals.air = 20;
  status.observations.missing = [];
  assert.equal(formatSurvivalStatus(status), "**Vitals:** Health 20/20; hunger 16/20.");
});

test("missing air warns only when the bot is in water", () => {
  const status = snapshot();
  status.vitals.inWater = true;
  assert.ok(formatSurvivalStatus(status).includes("in water, but its air supply is unavailable"));
});

test("active dangers and limitations remain visible", () => {
  const status = snapshot();
  status.summary = "responding";
  status.response = { capability: "fire_reflex", kind: "escape", phase: "moving", phaseTicks: 3, startedAt: 1 };
  status.dangers = [{ reflex: "fire_reflex", evidence: { burning: true }, selected: true,
    unresolved: true, observedAt: 1, stale: false }];
  status.policy.constraint = "No usable shield is equipped.";
  const text = formatSurvivalStatus(status);
  assert.ok(text.includes("Automatic fire response in progress (escape)"));
  assert.ok(text.includes("Unresolved fire danger"));
  assert.ok(text.includes("No usable shield is equipped."));
  status.summary = "standing_down";
  status.response = null;
  status.answered = [{ id: 1, capability: "fire_reflex", response: "escape", scope: "incident",
    facts: null, consumed: null, failure: { kind: "no_route", why: "No escape route was found." }, since: 1, temporal: null }];
  assert.ok(formatSurvivalStatus(status).includes("No escape route was found."));
});

test("death and disconnection remain explicit", () => {
  const status = snapshot();
  status.summary = "dead";
  assert.ok(formatSurvivalStatus(status).includes("The bot died."));
  status.owner.connected = false;
  assert.ok(formatSurvivalStatus(status).includes("Minecraft is disconnected"));
});

test("reflex notifications preserve observed interruption and eating evidence without phase chatter", (t) => {
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  const status = snapshot();
  const receipts: SurvivalReceipt[] = [
    { kind: "outcome" as const, source: "hostile_reflex", status, evidence: {
      response: "fight", interrupted: { action: "collect_block", startedAt: "now" },
      outcome: { outcome: "target_died", healthBefore: 20, healthAfter: 14 },
    } },
    { kind: "outcome" as const, source: "hunger_reflex", status, evidence: {
      outcome: { kind: "ate", food: "cooked_porkchop", hungerBefore: 16, hungerAfter: 20 },
    } },
  ];
  for (const receipt of receipts) recordEvent(data, "TestBot", {
    type: "survival_outcome", observedAt: new Date().toISOString(),
    summary: formatSurvivalOutcome(receipt), payload: receipt,
  });
  const summary = readNotificationSummary(data, "TestBot");
  assert.equal(summary.unreadCount, 2);
  assert.deepEqual(summary.recentPreview, [
    "hostile: target died; interrupted collect_block; health 20 → 14/20",
    "hunger: ate; cooked porkchop; hunger 16 → 20/20",
  ]);
  assert.deepEqual(readNotificationSummary(data, "TestBot"), summary, "Previews do not consume the unread cursor");
  assert.equal(readRecentEvents(data, "TestBot", 100).events.length, 2);
  assert.equal(readNotificationSummary(data, "TestBot").unreadCount, 0);
  assert.match(formatSurvivalOutcome({ ...receipts[1]!, evidence: {
    outcome: { kind: "eating_failed", food: "bread", error: "Consumption not observed" },
  } }), /eating failed; bread; Consumption not observed/);
});
