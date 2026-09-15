import { ExpectedMutationLedger } from "./mutations.js";
import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld } from "../../test-support/navigation.js";
import { blockKey, type BlockObservation, type BlockPosition } from "../world/world.js";

const TOKEN = { runId: "r", planId: "p", stepId: "s", attempt: 1 };

/** The predicate the ledger matches a cell against, named as its receipt reads. */
function reads(description: string, stateId: number) {
  return { description, matches: (block: BlockObservation) => block.kind === "loaded" && block.stateId === stateId };
}

test("expected mutation matching is distinct from route invalidation", async () => {
  const world = flatWorld();
  const ledger = new ExpectedMutationLedger();
  const position = { x: 1, y: 63, z: 0 };
  world.load(position, { stateId: 2 });
  const before = world.blockAt(position.x, position.y, position.z);
  const expectation = ledger.expect({
    token: TOKEN,
    position,
    before: reads("solid", 2),
    after: reads("air", 0),
    operation: "break",
    deadlineMs: Date.now() + 1000,
  });
  expectation.markIssued();
  world.load(position, { stateId: 0 });
  const after = world.blockAt(position.x, position.y, position.z);

  const classification = ledger.classify(
    { position, before, after, worldRevision: world.revision },
    new Set([blockKey(position)]),
    Date.now(),
  );
  assert.equal(classification, "expected");
  assert.equal((await expectation.result).kind, "confirmed");
});

test("a placement is contradicted neither by a no-op update nor by its own duplicate confirmation", async () => {
  const world = flatWorld();
  const ledger = new ExpectedMutationLedger();
  const position = { x: 1, y: 63, z: 0 };
  const before = world.blockAt(position.x, position.y, position.z);
  const placement = () =>
    ledger.expect({
      token: TOKEN,
      position,
      before: reads("air", 0),
      after: reads("placed", 10),
      operation: "place",
      deadlineMs: Date.now() + 1_000,
    });

  // A cell that did not change cannot contradict work that has not landed yet.
  const pending = placement();
  assert.equal(
    ledger.classify({ position, before, after: before, worldRevision: world.revision }, new Set(), Date.now()),
    "irrelevant",
  );
  assert.equal(ledger.activeCount, 1);
  world.load(position, { stateId: 10 });
  const placed = world.blockAt(position.x, position.y, position.z);
  assert.equal(
    ledger.classify({ position, before, after: placed, worldRevision: world.revision }, new Set(), Date.now()),
    "expected",
  );
  assert.equal((await pending.result).kind, "confirmed");

  // The server repeats the confirmation on a dependency cell; the repeat is a
  // receipt for the same placement, not a reason to invalidate the route.
  const repeated = placement();
  repeated.markIssued();
  const dependencies = new Set([blockKey(position)]);
  assert.equal(
    ledger.classify({ position, before, after: placed, worldRevision: 2 }, dependencies, Date.now()),
    "expected",
  );
  assert.equal(
    ledger.classify({ position, before: placed, after: placed, worldRevision: 3 }, dependencies, Date.now()),
    "expected",
  );
});

test("a break that brings a column down owns every change in that column", async () => {
  const world = flatWorld();
  const ledger = new ExpectedMutationLedger();
  const head = { x: 1, y: 64, z: 0 };
  const above = { x: 1, y: 65, z: 0 };
  world.load(head, { stateId: 2 });
  world.load(above, { stateId: 2 });
  const expectation = ledger.expect({
    token: TOKEN,
    position: head,
    before: reads("sand", 2),
    after: reads("air", 0),
    operation: "break",
    owned: [head, above],
    deadlineMs: Date.now() + 5_000,
  });
  expectation.markIssued();
  const dependencies = new Set([blockKey(head), blockKey(above)]);
  const change = (position: BlockPosition, stateId: number) => {
    const before = world.blockAt(position.x, position.y, position.z);
    world.load(position, { stateId });
    return {
      position,
      before,
      after: world.blockAt(position.x, position.y, position.z),
      worldRevision: world.revision,
    };
  };

  // The break itself, then the column turning to entities, landing, and being broken again.
  assert.equal(ledger.classify(change(head, 0), dependencies, Date.now()), "expected");
  assert.equal((await expectation.result).kind, "confirmed");
  assert.equal(ledger.classify(change(above, 0), dependencies, Date.now()), "expected");
  assert.equal(ledger.classify(change(head, 2), dependencies, Date.now()), "expected");
  assert.equal(ledger.classify(change(head, 0), dependencies, Date.now()), "expected");
  // A cell outside the column is still the world's.
  const outside = { x: 2, y: 64, z: 0 };
  assert.equal(ledger.classify(change(outside, 2), new Set([blockKey(outside)]), Date.now()), "invalidating");
});
