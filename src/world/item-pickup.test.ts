import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { MovementPolicy } from "../navigation/index.js";
import { botFixture, type FakeStack } from "../test-support/bot.js";
import { armSignal } from "../utils/index.js";
import {
  DROPPED_ITEM_OBSERVATION_EVENTS,
  droppedItemName,
  findNewItemEntity,
  pickupObservedItem,
  snapshotEntityIds,
} from "./item-pickup.js";

const DROP = new Vec3(3, 64, 0);

/**
 * A bot carrying `filledSlots` full stacks, with one observed white wool drop
 * as entity 7. The carried array is the live one, so a route can fill the last
 * slot the way tunnel spoil does.
 */
function pickupBot(filledSlots: number, drop: Record<string, unknown> = { name: "white_wool" }) {
  const items: FakeStack[] = Array.from({ length: filledSlots }, () => ({ name: "cobblestone", count: 64 }));
  const bot = botFixture({
    items,
    entities: { 7: { id: 7, position: DROP, getDroppedItem: () => drop } },
  });
  return { bot, items };
}

const OBSERVED_ITEM = { entityId: 7, movements: {} as MovementPolicy, hasArrived: () => false } as const;

/**
 * Both readings of a full inventory are the same fact for the caller: a
 * capacity refusal names the item, rather than blaming the route or arrival.
 */
const capacityCases = [
  { name: "an inventory already full before any route starts", carried: 36, fillsDuringRoute: false },
  { name: "a route whose spoil takes the last slot", carried: 35, fillsDuringRoute: true },
] as const;

for (const { name, carried, fillsDuringRoute } of capacityCases) {
  test(`${name} reports capacity rather than walking or blaming arrival`, async () => {
    const { bot, items } = pickupBot(carried);

    const result = await pickupObservedItem(bot, {
      ...OBSERVED_ITEM,
      navigate: async () => {
        if (!fillsDuringRoute) throw new Error("No pickup route should start without capacity.");
        items.push({ name: "cobblestone", count: 64 });
        return { status: "completed", elapsedMs: 1 };
      },
    });

    assert.equal(result.kind, "inventory_full");
    if (result.kind === "inventory_full") assert.match(result.reason, /INVENTORY_FULL.*white_wool/);
    assert.equal(bot.inventory.listenerCount("updateSlot"), 0, "the settle listener is released");
  });
}

test("an item disappearing during a stopped route is gone, not an unreachable pickup", async () => {
  const { bot } = pickupBot(0);

  const result = await pickupObservedItem(bot, {
    ...OBSERVED_ITEM,
    navigate: async () => {
      delete bot.entities[7];
      return { status: "stopped", reason: "Entity 7 is not currently observed.", elapsedMs: 0 };
    },
    settleMs: { itemGone: 50 },
  });

  assert.deepEqual(result, { kind: "item_gone" });
  assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
});

test("keeps observing until dropped-item metadata can identify the entity", async () => {
  let itemName: string | null = null;
  const entity = {
    id: 2,
    position: DROP,
    getDroppedItem: () => {
      if (!itemName) throw new Error("metadata not ready");
      return { name: itemName };
    },
  } as unknown as Bot["entity"];
  const events = botFixture({ entities: { 2: entity } });
  const sighting = armSignal(
    events,
    [...DROPPED_ITEM_OBSERVATION_EVENTS],
    () =>
      findNewItemEntity(events, {
        baseline: new Set(),
        itemName: "dirt",
        source: new Vec3(2, 64, 0),
        maxDistance: 4,
      }),
    {},
  );

  events.emit("entitySpawn", entity);
  itemName = "dirt";
  events.emit("entityUpdate", entity);

  assert.deepEqual(await sighting.promise, { kind: "signalled", value: { id: 2, position: DROP } });
});

test("attributes only a new matching item near the source, and unread metadata is no evidence yet", () => {
  const wool = (id: number, x: number) =>
    ({ id, position: new Vec3(x, 64, 0), getDroppedItem: () => ({ name: "white_wool" }) }) as Bot["entity"];
  const pending = {
    id: 3,
    position: DROP,
    getDroppedItem: () => {
      throw new Error("metadata not ready");
    },
  } as unknown as Bot["entity"];

  assert.equal(droppedItemName(wool(1, 1)), "white_wool");
  assert.equal(droppedItemName(pending), null, "metadata that has not arrived is not a name");

  const bot = { entities: { 1: wool(1, 1) } } as unknown as Bot;
  const baseline = snapshotEntityIds(bot);
  bot.entities[2] = wool(2, 3);
  bot.entities[3] = pending;

  assert.deepEqual(
    findNewItemEntity(bot, { baseline, itemName: "white_wool", source: new Vec3(2, 64, 0), maxDistance: 4 }),
    { id: 2, position: DROP },
  );
});
