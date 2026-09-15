import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, EQUIPMENT_SLOTS, type FakeStack } from "../../test-support/bot.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { formatDropItemResult, dropItem, type DropItemDependencies } from "./drop-item.js";

interface DropBotOptions {
  readonly carried: readonly FakeStack[];
  readonly worn?: Partial<Record<"head" | "torso" | "legs" | "feet" | "off-hand", string>>;
  readonly held?: string;
  /** Toss this item name throws instead of removing it. */
  readonly rejects?: string;
  /** Toss this item name silently succeeds without the inventory changing. */
  readonly swallows?: string;
  readonly players?: Record<string, { id: number; position: { x: number; y: number; z: number } }>;
  readonly position?: { x: number; y: number; z: number };
  /** Item entities already on the ground before the action runs. */
  readonly existingItems?: readonly { id: number; name: string; distance?: number }[];
  /** Entity id the server spawns for each successful toss, as the real one does. */
  readonly spawnsEntityId?: number;
}

function dropBot(options: DropBotOptions) {
  const items = options.carried.map((stack) => ({ ...stack }));
  const lookedAt: { x: number; y: number; z: number }[] = [];
  const slots: Record<number, { name: string } | null> = {};
  for (const [slot, name] of Object.entries(options.worn ?? {})) {
    if (name) slots[EQUIPMENT_SLOTS[slot]!] = { name };
  }

  /** Mineflayer tosses one identified stack, not "n of this name", so the fake must too. */
  const removeStack = (stack: FakeStack) => {
    const index = items.indexOf(stack);
    if (index >= 0) items.splice(index, 1);
  };
  const removeFrom = (stack: FakeStack, count: number) => {
    stack.count -= Math.min(stack.count, count);
    if (stack.count === 0) removeStack(stack);
  };

  const itemEntity = (id: number, name: string, distance = 1) => ({
    id,
    name: "item",
    position: new Vec3(0, 64, distance),
    getDroppedItem: () => ({ name }),
  });
  const entities: Record<number, unknown> = {};
  for (const existing of options.existingItems ?? []) {
    entities[existing.id] = itemEntity(existing.id, existing.name, existing.distance);
  }
  /** A successful toss makes the server spawn the item beside the bot. */
  const spawnTossed = (name: string) => {
    if (options.spawnsEntityId === undefined) return;
    entities[options.spawnsEntityId] = itemEntity(options.spawnsEntityId, name);
  };

  const bot = botFixture(
    {
      items,
      slots,
      entities,
      position: options.position,
      players: Object.fromEntries(
        Object.entries(options.players ?? {}).map(([name, player]) => [
          name,
          { entity: { id: player.id, position: new Vec3(player.position.x, player.position.y, player.position.z) } },
        ]),
      ),
    },
    {
      heldItem: options.held ? { name: options.held } : null,
      lookAt: async (position: { x: number; y: number; z: number }) => {
        lookedAt.push({ x: position.x, y: position.y, z: position.z });
      },
      tossStack: async (stack: FakeStack) => {
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeStack(stack);
        spawnTossed(stack.name);
      },
      toss: async (type: number, _metadata: number | null, count: number) => {
        const stack = items.find((candidate) => candidate.type === type);
        if (!stack) return;
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeFrom(stack, count);
        spawnTossed(stack.name);
      },
    },
  );
  return { bot, items, lookedAt, entities };
}

function deps(overrides: Partial<DropItemDependencies> = {}): DropItemDependencies {
  return {
    navigate: async () => ({ status: "completed", elapsedMs: 10 }) as never,
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "not placed in this test" }),
    createMovements: (() => ({})) as never,
    settleMs: 50,
    ...overrides,
  };
}

test("drops every stack of an item and reports the inventory delta", async () => {
  const { bot, items } = dropBot({
    carried: [
      { name: "cobblestone", count: 64, type: 1 },
      { name: "cobblestone", count: 12, type: 2 },
      { name: "diamond", count: 3, type: 3 },
    ],
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.carriedAfter]),
    [["cobblestone", 76, 0]],
  );
  assert.equal(result.drop.freeSlotsBefore, 33);
  assert.equal(result.drop.freeSlotsAfter, 35);
  assert.deepEqual(
    items.map((stack) => stack.name),
    ["diamond"],
  );
});

test("drops only the requested count, leaving the rest carried", async () => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 64, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "cobblestone", count: 10 }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.dropped[0]?.dropped, 10);
  assert.equal(result.drop.dropped[0]?.carriedAfter, 54);
});

test("never drops worn armour, and refuses the held item without allow_equipped", async () => {
  const { bot, items } = dropBot({
    carried: [
      { name: "iron_chestplate", count: 1, type: 1 },
      { name: "diamond_pickaxe", count: 1, type: 2 },
    ],
    worn: { torso: "iron_chestplate" },
    held: "diamond_pickaxe",
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\].*torso/);
  assert.match(result.drop.dropped[1]?.error ?? "", /\[DROP_HELD\].*allow_equipped/);
  assert.equal(items.length, 2, "nothing was tossed");
});

test("allow_equipped releases the held item but never the worn one", async () => {
  const { bot } = dropBot({
    carried: [
      { name: "iron_chestplate", count: 1, type: 1 },
      { name: "diamond_pickaxe", count: 1, type: 2 },
    ],
    worn: { torso: "iron_chestplate" },
    held: "diamond_pickaxe",
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({
      items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }],
      allow_equipped: true,
    }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "partial");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 1);
});

test("reports an item that is not carried without touching the others", async () => {
  const { bot } = dropBot({ carried: [{ name: "gravel", count: 4, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "clay_ball" }, { item_name: "gravel" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "partial");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_NOT_CARRIED\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 4);
  assert.match(result.error ?? "", /\[DROP_INCOMPLETE\] 1 of 2 items/);
});

test("a toss the server swallows or rejects is reported, not assumed", async () => {
  const gravel = parseDropItemRequest({ items: [{ item_name: "gravel" }] });
  const carried = [{ name: "gravel", count: 4, type: 1 }];

  const swallowed = await dropItem(
    dropBot({ carried, swallows: "gravel" }).bot,
    gravel,
    {},
    deps(),
    createDiscardedItems(),
  );
  assert.equal(swallowed.status, "failed");
  assert.match(swallowed.drop.dropped[0]?.error ?? "", /\[DROP_NOT_OBSERVED\].*gravel x4/);

  const rejected = await dropItem(
    dropBot({ carried, rejects: "gravel" }).bot,
    gravel,
    {},
    deps(),
    createDiscardedItems(),
  );
  assert.equal(rejected.status, "failed");
  assert.match(rejected.drop.dropped[0]?.error ?? "", /\[DROP_REJECTED\].*server refused/);
});

test("walks to the named player, faces them, and records the handover", async () => {
  const { bot, lookedAt } = dropBot({
    carried: [{ name: "bread", count: 8, type: 1 }],
    players: { Dev: { id: 42, position: { x: 1, y: 64, z: 1 } } },
    position: { x: 0, y: 64, z: 0 },
  });
  let goalRange: number | null = null;

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Dev" }),
    {},
    deps({
      navigate: (async (options: { goal: unknown }) => {
        goalRange = (options.goal as { range?: number }).range ?? null;
        return { status: "completed", elapsedMs: 5 };
      }) as never,
    }),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.name, "Dev");
  assert.equal(result.drop.dropped[0]?.dropped, 8);
  assert.deepEqual(lookedAt, [{ x: 1, y: 64, z: 1 }], "faced the player before tossing");
  assert.equal(goalRange, null, "the entity goal carries its own range");
});

test("refuses to hand items to a player who is not loaded, dropping nothing", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "bread", count: 8, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Ghost" }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_NOT_FOUND\] No player named Ghost/);
  assert.deepEqual(result.drop.dropped, []);
  assert.equal(items.length, 1, "nothing was tossed");
});

test("reports a player the route could not reach", async () => {
  const { bot } = dropBot({
    carried: [{ name: "bread", count: 8, type: 1 }],
    players: { Dev: { id: 42, position: { x: 40, y: 64, z: 40 } } },
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Dev" }),
    {},
    deps({ navigate: (async () => ({ status: "stopped", elapsedMs: 900, reason: "no route" })) as never }),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_UNREACHABLE\] Pathfinder could not reach Dev/);
});

test("registers only what it actually tossed, so a later sweep leaves that alone and nothing else", async () => {
  const cobblestone = parseDropItemRequest({ items: [{ item_name: "cobblestone" }] });
  const carried = [{ name: "cobblestone", count: 64, type: 1 }];

  // The tossed stack is remembered; a diamond already lying there is not this bot's discard.
  const { bot, entities } = dropBot({ carried, existingItems: [{ id: 12, name: "diamond" }], spawnsEntityId: 77 });
  const discarded: DiscardedItems = createDiscardedItems();
  const result = await dropItem(bot, cobblestone, {}, deps(), discarded);
  assert.equal(result.status, "succeeded");
  assert.deepEqual([discarded.ignored().has(77), discarded.ignored().has(12)], [true, false]);

  // A mob dies across the clearing while the toss is settling: too far away to be this toss.
  entities[99] = { id: 99, name: "item", position: new Vec3(0, 64, 30), getDroppedItem: () => ({ name: "bone" }) };
  assert.equal(discarded.ignored().has(99), false);

  // Nothing tossed, nothing claimed, even when an item spawns.
  const swallowed = createDiscardedItems();
  const { bot: silent } = dropBot({
    carried: [{ name: "gravel", count: 4, type: 1 }],
    swallows: "gravel",
    spawnsEntityId: 77,
  });
  const failed = await dropItem(
    silent,
    parseDropItemRequest({ items: [{ item_name: "gravel" }] }),
    {},
    deps(),
    swallowed,
  );
  assert.equal(failed.status, "failed");
  assert.deepEqual([...swallowed.ignored()], []);
});

test("formats the drop, the location, and the pickup warning", () => {
  const markdown = formatDropItemResult({
    status: "succeeded",
    drop: {
      dropped: [{ item: "cobblestone", requested: null, carriedBefore: 64, carriedAfter: 0, dropped: 64 }],
      freeSlotsBefore: 2,
      freeSlotsAfter: 3,
      droppedAt: { x: 100.5, y: 3, z: 92.5 },
      recipient: null,
      hole: null,
      holeClosure: null,
    },
  });

  assert.match(markdown, /Dropped \*\*cobblestone\*\* x64/);
  assert.match(markdown, /Dropped at `100\.5, 3\.0, 92\.5`/);
  assert.match(markdown, /Free slots 2 → 3/);
  assert.match(markdown, /despawn after about five minutes/);
});
