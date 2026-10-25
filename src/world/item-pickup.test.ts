import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { MovementPolicy } from "../navigation/index.js";
import type { PlannedStep } from "../navigation/movements/movement.js";
import { createMovementPolicy } from "../navigation/movements/policy.js";
import { runNavigation } from "../navigation/navigate.js";
import { createNavigator } from "../navigation/orchestration/navigator.js";
import type { NavigationObservation } from "../navigation/world/world.js";
import { botFixture, type FakeStack } from "../test-support/bot.js";
import { FakeNavigationBot, flatWorld, observation } from "../test-support/navigation.js";
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

test("a pickup observed during the arrival approach is collected, and stopping the approach crashes nothing", async () => {
  // The bow-range ledge: a blaze rod rolled into reach while a partial route
  // was walked, the approach began closing on it, and the inventory proved the
  // pickup mid-approach. The route's stop then rejected the approach's tick
  // wait with "pickup_observed" where nothing was listening, and Bun ended the
  // client process although the request itself succeeded.
  const { bot } = pickupBot(0);
  let collected = false;
  let approaching = false;
  // The approach steers once per tick; its first steering is the pickup's cue.
  (bot as unknown as { setControlState: () => void }).setControlState = () => {
    if (approaching || collected) return;
    approaching = true;
    setTimeout(() => {
      collected = true;
      bot.inventory.emit("updateSlot");
    }, 5);
  };
  const dropAt = (x: number): NavigationObservation => ({
    ...observation(x),
    entities: new Map([[7, { id: 7, position: { x: x + 0.5, y: 63, z: 0.5 }, width: 0.25, height: 0.25 }]]),
  });
  class RollingDropBot extends FakeNavigationBot {
    constructor() {
      super();
      this.current = { ...dropAt(-5), entities: dropAt(5).entities };
    }
    override async prepareMovement(step: PlannedStep, _token?: unknown, signal?: AbortSignal) {
      // The drop rolls to where the body is before the step reports itself done.
      this.arrive(step.to, dropAt(step.to.x));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30);
        signal?.addEventListener("abort", () => (clearTimeout(timer), setTimeout(resolve, 30)), { once: true });
      });
      return { kind: "completed", arrival: step.to } as const;
    }
  }
  const navigator = createNavigator({ world: flatWorld(), bot: new RollingDropBot() });

  const result = await pickupObservedItem(bot, {
    ...OBSERVED_ITEM,
    movements: createMovementPolicy({ allowSprinting: false }),
    hasArrived: () => collected,
    // Commit a partial route at once, so a plan-ahead search runs beside it.
    navigate: (options) => runNavigation(navigator, { ...options, searchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 } }),
  });

  assert.equal(approaching, true, "the pickup was observed during the arrival approach");
  assert.deepEqual(result, { kind: "collected" });
  assert.equal(navigator.running, false);
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
