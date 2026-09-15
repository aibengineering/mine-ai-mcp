import assert from "node:assert/strict";
import test from "node:test";
import { Answered } from "./answered.js";

test("a failed scope captures its own construction and consumes only relevant permissions", () => {
  const answered = new Answered();
  const terrain = { cell: "0,64,0", wall: "stone" };
  const policy = { place: true, bow: true };
  const read = {
    capability: "hide",
    response: "enclose",
    scope: "cell:0,64,0",
    facts: () => terrain,
    permissions: () => ({ place: policy.place }),
  };
  terrain.wall = "cobblestone";
  const entry = answered.remember(read, { kind: "no_passage", why: "The finished wall obstructed the exit." });
  policy.bow = false;
  assert.equal(answered.find("hide", read.scope)?.id, entry.id);
  policy.place = false;
  assert.equal(answered.find("hide", read.scope), null);
});

test("failed recovery does not erase enclosure or rearm on damage", () => {
  const answered = new Answered();
  let food = 3;
  const read = {
    capability: "recovery",
    response: "recover",
    scope: "protected-cell",
    facts: () => ({ usableFood: food }),
    permissions: () => ({ recover: "when_possible" }),
  };
  answered.remember(read, { kind: "budget_exhausted", why: "Health did not reach the requested bar." });
  assert.equal(answered.find("hide", "protected-cell"), null);
  assert.equal(answered.find("recovery", "protected-cell")?.failure.kind, "budget_exhausted");
  food = 0;
  assert.equal(answered.find("recovery", "protected-cell"), null);
});

test("only a declared temporal premise expires, and one arrangement cannot exclude another", () => {
  let now = 100;
  const answered = new Answered(() => now);
  const scope = { capability: "position", response: "fight", scope: "A", facts: () => null, permissions: () => null };
  answered.remember(scope, { kind: "unproductive", why: "No requested-target damage." });
  answered.remember(
    { ...scope, scope: "B" },
    { kind: "projectile_window", why: "Shot still crossing the opening." },
    { premise: "flight_complete", expiresAt: 200, why: "Observed launch and predicted flight duration." },
  );
  now = 200;
  assert.ok(answered.find("position", "A"));
  assert.equal(answered.find("position", "B"), null);
  answered.clear();
  assert.deepEqual(answered.snapshot(), []);
});
