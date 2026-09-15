import assert from "node:assert/strict";
import test from "node:test";
import { RequestProgress } from "../session/progress.js";
import { formatPolicyReminder, formatProtocol, formatForegroundStatus } from "./async-format.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import { DEFAULT_SURVIVAL_POLICY } from "../survival/policy/contract.js";

test("large build objectives summarize cells without losing current progress or modifying structured evidence", () => {
  const cells = Array.from({ length: 100 }, (_, index) => ({ x: index % 5, y: 71 + Math.floor(index / 25), z: 153 + Math.floor(index / 5) % 5, blockName: index < 80 ? "cobblestone" : "air" }));
  const progress = new RequestProgress({ dimension: "overworld", x: 0, y: 72, z: 155 }).snapshot();
  const live = { actionId: "shelter", action: "build_structure", progress, request: {
    id: "shelter", requestId: 1, action: "build_structure", admittedAt: 0,
    state: { kind: "running" as const }, objective: { cells, removeWrongBlocks: true },
    evidence: { baseline: { correct: 15 }, checkpoint: { correct: 41, requested: 100, remaining: 59, placed: 21 },
      completion: { kind: "current" as const, observed: false, owes: "All requested cells currently contain their specified blocks." } },
  } };
  const before = structuredClone(live);
  const markdown = formatProtocol({ state: "pending", wakeReason: "timeout", actionId: "shelter", progress: live,
    duringWait: { from: progress.sampledAt, to: progress.sampledAt, elapsedMs: 20000, suspendedMs: 0, distanceTravelledBlocks: 0, reflexDistanceBlocks: 0,
      combatResources: { arrowsFired: 0, arrowsRecovered: 0, durabilityUsed: [], shieldBlocks: 0, foodEaten: 0, scaffoldPlaced: 0, weaponChanges: [] }, reflexActivity: [],
      checkpointDelta: { correct: 26 }, toolChanges: [{
      class: "pickaxe", reason: "durability_used",
      before: { class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 36, durabilityLeft: 9, maximumDurability: 250 },
      now: { class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 36, durabilityLeft: 4, maximumDurability: 250 },
    }] },
  });
  assert.match(markdown, /100 cells: 80 cobblestone, 20 air/);
  assert.match(markdown, /Bounds: \(0, 71, 153\) to \(4, 74, 157\)/);
  assert.match(markdown, /Remaining:\*\* 59/);
  assert.match(markdown, /Correct:\*\* \+26/);
  assert.match(markdown, /Tool:\*\* pickaxe durability 9 → 4/);
  assert.doesNotMatch(markdown, /Cells 99/);
  assert.ok(markdown.length < 2000, markdown.length.toString());
  assert.deepEqual(live, before);
  assert.match(formatForegroundStatus({ active: live, awaitingResult: null, storageError: null }), /100 cells: 80 cobblestone, 20 air/);
});

test("combat resource totals and waiter-local changes are visible in Markdown", () => {
  const measured = new RequestProgress(null);
  measured.combatResource({ kind: "arrow_fired" });
  measured.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 4, now: 5 });
  const progress = measured.snapshot();
  const markdown = formatProtocol({ state: "pending", wakeReason: "timeout", actionId: "hunt", progress: {
    actionId: "hunt", action: "collect_mob_drop", progress, request: null,
  }, duringWait: { from: progress.sampledAt, to: progress.sampledAt, elapsedMs: 1000, suspendedMs: 0,
    distanceTravelledBlocks: 0, reflexDistanceBlocks: 0, checkpointDelta: {}, toolChanges: [], combatResources: progress.combatResources, reflexActivity: [] },
  });
  assert.ok(markdown.includes("**Combat resources during this wait:** Arrows fired: 1; durability used: iron\\_sword slot 36: 4 → 5."));
});

test("reflex activity separates policy-withheld responses from other exclusions in Markdown", () => {
  const measured = new RequestProgress(null);
  measured.reflexActivity({ kind: "entered", state: { kind: "response", reflex: "hostile", name: "fight", exclusion: null, detail: null } });
  measured.reflexActivity({ kind: "left", state: { kind: "response", reflex: "hostile", name: "fight", exclusion: null, detail: null } });
  measured.reflexActivity({ kind: "entered", state: { kind: "withheld", reflex: "hostile", name: "hide", exclusion: "prohibited", detail: "hide" } });
  measured.reflexActivity({ kind: "entered", state: { kind: "withheld", reflex: "hostile", name: "evade", exclusion: "answered", detail: "3" } });
  measured.reflexActivity({ kind: "entered", state: { kind: "combat_phase", reflex: "combat", name: "approach", exclusion: null, detail: null } });
  const progress = measured.snapshot();
  const markdown = formatProtocol({ state: "pending", wakeReason: "timeout", actionId: "hunt", progress: {
    actionId: "hunt", action: "collect_mob_drop", progress, request: null,
  }, duringWait: { from: progress.sampledAt, to: progress.sampledAt, elapsedMs: 1000, suspendedMs: 0,
    distanceTravelledBlocks: 0, reflexDistanceBlocks: 0, checkpointDelta: {}, toolChanges: [], combatResources: progress.combatResources,
    reflexActivity: progress.reflexActivity.map((state) => ({ ...state, activeMs: 1500 })) },
  });
  assert.match(markdown, /\*\*Reflexes:\*\* responses: hostile fight ×1 \(\d+ms\); withheld by policy: hostile hide ×1 \(\d+ms\) by hide; withheld otherwise: hostile evade ×1 \(\d+ms\) answered 3; combat phases: approach ×1 \(\d+ms\)\./);
  assert.match(markdown, /\*\*Reflexes during this wait:\*\* responses: hostile fight ×1 \(1\.5s\);/);
});

test("the survival policy reminder appears only when combat or a policy refusal shaped the interval", () => {
  const measured = new RequestProgress(null);
  const quiet = measured.snapshot();
  const survival = {
    summary: "safe", request: null, owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: { revision: "7", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY, overrides: [
      { path: "combat.melee", value: false, lifetime: { kind: "session" }, reason: "test", since: 1, expiresAt: null },
      { path: "combat.bow", value: false, lifetime: { kind: "session" }, reason: "test", since: 1, expiresAt: null },
    ], encounter: null, response: null, settling: false, lastChange: "test", constraint: null },
    vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 1, physicsObservedAt: 1 },
  } satisfies SurvivalStatus;
  const wait = (progress: typeof quiet) => ({ from: progress.sampledAt, to: progress.sampledAt, elapsedMs: 1000, suspendedMs: 0,
    distanceTravelledBlocks: 0, reflexDistanceBlocks: 0, checkpointDelta: {}, toolChanges: [], combatResources: progress.combatResources,
    reflexActivity: progress.reflexActivity });
  const live = (progress: typeof quiet) => ({ actionId: "hunt", action: "collect_mob_drop", progress, request: null });
  assert.doesNotMatch(formatProtocol({ state: "pending", wakeReason: "timeout", actionId: "hunt", progress: live(quiet), duringWait: wait(quiet), survival }), /Survival policy in effect/);
  measured.reflexActivity({ kind: "entered", state: { kind: "response", reflex: "hostile_reflex", name: "evade", exclusion: null, detail: null } });
  const fought = measured.snapshot();
  const markdown = formatProtocol({ state: "pending", wakeReason: "timeout", actionId: "hunt", progress: live(fought), duringWait: wait(fought), survival });
  assert.match(markdown, /\*\*Survival policy in effect:\*\* combat\.melee=false, combat\.bow=false \(revision 7\)\./);
  assert.equal(formatPolicyReminder({ ...survival, policy: { ...survival.policy, overrides: [] } }, fought.reflexActivity),
    "**Survival policy in effect:** defaults, no overrides (revision 7).");
  assert.equal(formatPolicyReminder(undefined, fought.reflexActivity), null);
});
