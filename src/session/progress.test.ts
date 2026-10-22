import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { progressChange, RequestProgress } from "./progress.js";

/**
 * `RequestProgress` measures every interval with `performance.now`, read when
 * it is constructed and at each event. Setting that clock makes suspended,
 * stale and active time exact instead of slept for and bounded from below.
 * Create the progress after calling this.
 */
function mockedNow(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

test("combat resources retain request totals and each waiter gets its own delta", () => {
  const progress = new RequestProgress({ dimension: "overworld", x: 0, y: 64, z: 0 });
  progress.combatResource({ kind: "arrow_fired" });
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 3, now: 4 });
  const first = progress.snapshot();
  progress.combatResource({ kind: "arrow_fired" });
  progress.combatResource({ kind: "arrow_recovered" });
  progress.combatResource({ kind: "shield_block" });
  progress.combatResource({ kind: "food_eaten" });
  progress.combatResource({ kind: "scaffold_placed" });
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 4, now: 6 });
  progress.combatResource({ kind: "weapon_changed", from: "bow", to: "iron_sword", reason: "observed during combat takeover" });
  const final = progress.finish();
  assert.deepEqual(final.combatResources, {
    arrowsFired: 2, arrowsRecovered: 1,
    durabilityUsed: [{ slot: 36, item: "iron_sword", before: 3, now: 6 }],
    shieldBlocks: 1, foodEaten: 1, scaffoldPlaced: 1,
    weaponChanges: [{ from: "bow", to: "iron_sword", reason: "observed during combat takeover" }],
  });
  assert.deepEqual(progressChange(first, final, null, null).combatResources, {
    arrowsFired: 1, arrowsRecovered: 1,
    durabilityUsed: [{ slot: 36, item: "iron_sword", before: 4, now: 6 }],
    shieldBlocks: 1, foodEaten: 1, scaffoldPlaced: 1,
    weaponChanges: [{ from: "bow", to: "iron_sword", reason: "observed during combat takeover" }],
  });
});

test("durability from a replacement stack remains a separate observed interval", () => {
  const progress = new RequestProgress(null);
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 9, now: 10 });
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 0, now: 1 });
  assert.deepEqual(progress.snapshot().combatResources.durabilityUsed,
    [{ slot: 36, item: "iron_sword", before: 9, now: 10 }, { slot: 36, item: "iron_sword", before: 0, now: 1 }]);
});

test("a replacement with identical wear is still a new waiter-local durability interval", () => {
  const progress = new RequestProgress(null);
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 9, now: 10 });
  const before = progress.snapshot();
  progress.combatResource({ kind: "durability_used", slot: 36, item: "iron_sword", before: 9, now: 10 });
  assert.deepEqual(progressChange(before, progress.snapshot(), null, null).combatResources.durabilityUsed,
    [{ slot: 36, item: "iron_sword", before: 9, now: 10 }]);
});

test("reflex activity counts entries, accrues time in state, and yields waiter-local deltas", (t) => {
  const clock = mockedNow(t);
  const progress = new RequestProgress(null);
  const hide = { kind: "withheld", reflex: "hostile", name: "hide", exclusion: "prohibited", detail: "hide" } as const;
  const fight = { kind: "response", reflex: "hostile", name: "fight", exclusion: null, detail: null } as const;
  progress.reflexActivity({ kind: "active", state: hide });
  progress.reflexActivity({ kind: "entered", state: fight });
  clock.advance(20);
  progress.reflexActivity({ kind: "left", state: fight });
  const first = progress.snapshot();
  const carried = first.reflexActivity.find((state) => state.name === "hide");
  const fought = first.reflexActivity.find((state) => state.name === "fight");
  assert.equal(carried?.entries, 0, "a state occupied at admission is not an entry");
  assert.equal(carried?.activeMs, 20, "time in a carried state still accrues");
  assert.equal(fought?.entries, 1);
  assert.equal(fought?.activeMs, 20);
  progress.reflexActivity({ kind: "entered", state: fight });
  progress.reflexActivity({ kind: "entered", state: fight });
  progress.reflexActivity({ kind: "left", state: fight });
  progress.reflexActivity({ kind: "left", state: fight });
  const change = progressChange(first, progress.snapshot(), null, null).reflexActivity;
  assert.deepEqual(change.filter((state) => state.name === "fight").map((state) => state.entries), [1], "re-entry is one entry; a repeated arrival and a spurious exit are ignored");
  progress.finish();
  progress.reflexActivity({ kind: "entered", state: fight });
  assert.equal(progress.snapshot().reflexActivity.find((state) => state.name === "fight")?.entries, 2, "finished progress ignores later activity");
});

test("progress marks absent physics samples and retains regressing inventory evidence", (t) => {
  const clock = mockedNow(t);
  const p = new RequestProgress({ dimension: "overworld", x: 0, y: 64, z: 0 });
  const before = p.snapshot();
  p.transition("suspended");
  clock.advance(10);
  p.transition("resuming");
  clock.advance(10);
  assert.equal(p.snapshot().suspendedMs, 20, "resuming is still time away from the task");
  p.transition("running");
  clock.advance(1010);
  const stale = p.snapshot();
  assert.equal(stale.movementCoverage.complete, false, "more than a second without a sample is a coverage gap");
  assert.equal(stale.positionAgeMs, 1030);
  p.sample({ dimension: "overworld", x: 100, y: 64, z: 0 }, false);
  assert.equal(p.snapshot().distanceTravelledBlocks, 0, "a straight line across a gap is not travel");
  const evidence = (gained: number) => ({ baseline: null, checkpoint: { items: [{ item: "iron_ingot", gained }] },
    completion: { kind: "current" as const, observed: false, owes: "Keep the requested items" } });
  assert.equal(progressChange(before, p.snapshot(), evidence(5), evidence(2)).checkpointDelta["items.iron_ingot.gained"], -3);
});

test("each waiter sees only tool changes since its own progress baseline", () => {
  let durabilityLeft = 9;
  const p = new RequestProgress(null, () => ({ tools: [{ class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 36,
    durabilityLeft, maximumDurability: 250 }], armour: [] }));
  const first = p.snapshot();
  durabilityLeft = 4;
  const second = p.snapshot();
  assert.deepEqual(progressChange(first, second, null, null).toolChanges.map((change) => change.reason), ["durability_used"]);
  assert.deepEqual(progressChange(second, second, null, null).toolChanges, []);
});

test("distance counts real segments across routes, excludes jumps, and freezes its final snapshot", () => {
  const p = new RequestProgress({ dimension: "overworld", x: 0, y: 64, z: 0 });
  p.sample({ dimension: "overworld", x: 3, y: 64, z: 4 }, false);
  p.transition("suspended");
  p.sample({ dimension: "overworld", x: 0, y: 64, z: 0 }, true);
  assert.equal(p.snapshot().distanceTravelledBlocks, 10);
  assert.equal(p.snapshot().reflexDistanceBlocks, 5);
  assert.equal(p.snapshot().distanceFromStartBlocks, 0);
  p.sample({ dimension: "the_nether", x: 1000, y: 64, z: 0 }, true, "portal");
  assert.equal(p.snapshot().distanceTravelledBlocks, 10);
  assert.equal(p.snapshot().distanceFromStartBlocks, null);
  const final = p.finish();
  p.sample({ dimension: "the_nether", x: 1010, y: 64, z: 0 }, false);
  assert.deepEqual(p.snapshot(), final);
});
