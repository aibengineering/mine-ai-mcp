import assert from "node:assert/strict";
import test from "node:test";
import { progressChange, RequestProgress } from "./progress.js";

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

test("reflex activity counts entries, accrues time in state, and yields waiter-local deltas", async () => {
  const progress = new RequestProgress(null);
  const hide = { kind: "withheld", reflex: "hostile", name: "hide", exclusion: "prohibited", detail: "hide" } as const;
  const fight = { kind: "response", reflex: "hostile", name: "fight", exclusion: null, detail: null } as const;
  progress.reflexActivity({ kind: "active", state: hide });
  progress.reflexActivity({ kind: "entered", state: fight });
  await new Promise((resolve) => setTimeout(resolve, 20));
  progress.reflexActivity({ kind: "left", state: fight });
  const first = progress.snapshot();
  const carried = first.reflexActivity.find((state) => state.name === "hide");
  const fought = first.reflexActivity.find((state) => state.name === "fight");
  assert.equal(carried?.entries, 0, "a state occupied at admission is not an entry");
  assert.ok((carried?.activeMs ?? 0) >= 15, "time in a carried state still accrues");
  assert.equal(fought?.entries, 1);
  assert.ok((fought?.activeMs ?? 0) >= 15);
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
