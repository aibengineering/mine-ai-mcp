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

test("one arrangement cannot exclude another", () => {
  const answered = new Answered();
  const scope = { capability: "position", response: "fight", scope: "A", facts: () => null, permissions: () => null };
  const a = answered.remember(scope, { kind: "unproductive", why: "No requested-target damage." });
  // Remembering scope B replaces only an earlier B of the same capability.
  const b = answered.remember({ ...scope, scope: "B" }, { kind: "projectile_window", why: "Shot still crossing the opening." });
  assert.equal(answered.find("position", "A")?.id, a.id);
  assert.equal(answered.find("position", "B")?.id, b.id);
  answered.clear();
  assert.deepEqual(answered.snapshot(), []);
});
