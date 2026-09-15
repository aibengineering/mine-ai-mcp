import assert from "node:assert/strict";
import test from "node:test";
import { createDiscardedItems, DISCARD_MEMORY_MS } from "./discarded-items.js";
import { findNewItemEntity } from "./item-pickup.js";

test("remembers discarded ids until they expire, extending on a repeat and pruning the rest", () => {
  const discarded = createDiscardedItems(1_000);
  discarded.remember([7, 9], 0);
  assert.deepEqual([...discarded.ignored(500)].sort(), [7, 9]);
  assert.equal(discarded.ignored(500).has(11), false);
  assert.equal(discarded.ignored(1_000).has(9), false, "expiry is exclusive at the boundary");

  // A later discard of the same id extends its life.
  discarded.remember([7], 900);
  assert.equal(discarded.ignored(1_500).has(7), true);
  assert.equal(discarded.ignored(1_901).has(7), false);

  // Expired entries are pruned rather than accumulating: id n expires at n + 1,000.
  const crowded = createDiscardedItems(1_000);
  for (let id = 0; id < 50; id++) crowded.remember([id], id);
  assert.equal(crowded.ignored(1_040).size, 9);

  // The default lifetime is a dropped item's own five minutes.
  assert.equal(DISCARD_MEMORY_MS, 300_000);
  const defaulted = createDiscardedItems();
  defaulted.remember([1], 0);
  assert.equal(defaulted.ignored(299_999).has(1), true);
  assert.equal(defaulted.ignored(300_000).has(1), false);
});

test("findNewItemEntity skips ids the bot discarded on purpose", () => {
  const position = (x: number) => ({
    x,
    y: 64,
    z: 0,
    distanceTo: (other: { x: number }) => Math.abs(x - other.x),
    clone: () => position(x),
  });
  const entity = (id: number, name: string, x: number) => ({
    id,
    name: "item",
    position: position(x),
    getDroppedItem: () => ({ name }),
  });
  const bot = { entities: { 1: entity(1, "cobblestone", 1), 2: entity(2, "diamond", 2) } } as never;
  const source = { x: 0, y: 64, z: 0 };

  const withoutSuppression = findNewItemEntity(bot, { baseline: new Set(), source, maxDistance: 8 });
  assert.equal(withoutSuppression?.id, 1, "the nearest item wins when nothing is suppressed");

  const discarded = createDiscardedItems();
  discarded.remember([1]);
  const suppressed = findNewItemEntity(bot, {
    baseline: new Set(),
    source,
    maxDistance: 8,
    ignoreIds: discarded.ignored(),
  });
  assert.equal(suppressed?.id, 2, "the discarded stack is skipped for the next item along");

  discarded.remember([2]);
  assert.equal(
    findNewItemEntity(bot, { baseline: new Set(), source, maxDistance: 8, ignoreIds: discarded.ignored() }),
    null,
    "everything discarded means nothing to sweep",
  );
});
