import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { botFixture, registry, type FakeStack } from "../../test-support/bot.js";
import { prepareDisposalHole, observeHoleDrops, sealDisposalHole, snapshotDroppedCounts } from "./disposal-hole.js";
import { blockClass } from "../../world/block-class.js";

const Block = blockClass({ registry } as Pick<Bot, "registry">);

/** Dirt below y 64 and air above, as real Prismarine blocks, with every cell the test changes by name. */
function ground(carried: FakeStack[] = []) {
  const changed = new Map<string, string>();
  const bot = botFixture({
    items: carried,
    blocks: (position) => {
      const name = changed.get(position.toString()) ?? (position.y < 64 ? "dirt" : "air");
      return Block.fromStateId(registry.blocksByName[name]!.defaultState, 0) as never;
    },
  });
  return { bot, changed };
}

/** A placement that fills the cell with the chosen item and spends one of it. */
function fakePlacement(changed: Map<string, string>, placed: { cell: Vec3; item: string }[]) {
  return (async (bot: Bot, cell: { x: number; y: number; z: number }, item: { name: string; count: number } | null) => {
    if (!item) return { kind: "failed" as const, error: "no item" };
    const position = new Vec3(cell.x, cell.y, cell.z);
    placed.push({ cell: position, item: item.name });
    changed.set(position.toString(), item.name);
    item.count -= 1;
    // Mineflayer drops a spent stack from the inventory rather than listing it at zero.
    const carried = bot.inventory.items() as unknown as { count: number }[];
    if (item.count === 0) carried.splice(carried.indexOf(item), 1);
    return { kind: "placed" as const, block: bot.blockAt(position)! };
  }) as never;
}

test("the shaft above the discards is plugged first, then the ground-level cell", async () => {
  const { bot, changed } = ground([
    { name: "oak_log", count: 5 },
    { name: "cobblestone", count: 2 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {});

  assert.deepEqual(seal, { item: "cobblestone", placed: 2 });
  assert.deepEqual(
    placed.map((entry) => [entry.cell.y, entry.item]),
    [
      [63, "cobblestone"],
      [64, "cobblestone"],
    ],
    "scaffold material is preferred over other carried blocks",
  );
  assert.equal(bot.blockAt(new Vec3(1, 62, 0))?.name, "air", "the discards' own cell is left alone");
});

test("a partly plugged hole reports what was placed and why it stopped", async () => {
  const { bot, changed } = ground([
    { name: "dirt", count: 1 },
    { name: "sand", count: 64 },
    { name: "crafting_table", count: 1 },
    { name: "stick", count: 3 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {});

  assert.equal(seal.item, "dirt");
  assert.equal(seal.placed, 1);
  assert.match(seal.error ?? "", /DROP_HOLE_OPEN.*\(1, 64, 0\)/);
  assert.deepEqual(
    placed.map((entry) => entry.item),
    ["dirt"],
    "falling blocks, workstations, and non-blocks are never used as a plug",
  );
});

test("an empty hand leaves the hole open without failing the drop", async () => {
  const { bot, changed } = ground();
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, []), {});

  assert.equal(seal.placed, 0);
  assert.equal(seal.item, null);
  assert.match(seal.error ?? "", /DROP_HOLE_OPEN/);
});

test("the plug never spends the item the request is discarding", async () => {
  // disposal-holes, Full: with all 36 slots full, the hole's stone spoil
  // cannot be picked up while digging. Whether it is in hand by the plug is a
  // race with the toss that frees slots; seven of eight trials plugged with
  // netherrack instead, and ended one or two short of the 2048 the request
  // left carried.
  const { bot, changed } = ground([
    { name: "diamond_pickaxe", count: 1 },
    { name: "netherrack", count: 64 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const open = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {}, new Set(["netherrack"]));

  assert.equal(open.placed, 0);
  assert.match(open.error ?? "", /DROP_HOLE_OPEN.*other than the items discarded/);
  assert.equal(bot.inventory.items().find((item) => item.name === "netherrack")?.count, 64);

  (bot.inventory.items() as unknown as FakeStack[]).push({ name: "cobblestone", count: 2, type: registry.itemsByName.cobblestone!.id });
  const spoil = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {}, new Set(["netherrack"]));

  assert.deepEqual(spoil, { item: "cobblestone", placed: 2 }, "the spoil, once picked up, still plugs it");
});

test("hole preparation refuses liquid beside its shaft without digging", async () => {
  const { bot, changed } = ground();
  for (const [x, z] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ])
    changed.set(new Vec3(x, 62, z).toString(), "water");
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async () => {
        assert.fail("A shaft that opens into liquid must not be dug.");
      },
      {},
    ),
    /DROP_HOLE_UNAVAILABLE/,
  );
});

test("cancellation after the first hole block prevents the second dig", async () => {
  const { bot, changed } = ground();
  const stop = new AbortController();
  const digs: number[] = [];
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        digs.push(position.y);
        changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
        stop.abort(new Error("stop disposal"));
        return { status: "broken" };
      },
      { signal: stop.signal },
    ),
    /stop disposal/,
  );
  assert.deepEqual(digs, [63]);
});

test("a tunnel wall is excavated above an enclosed disposal pit", async () => {
  const { bot, changed } = ground();
  changed.set(new Vec3(1, 64, 0).toString(), "stone");
  changed.set(new Vec3(1, 65, 0).toString(), "stone");
  const digs: number[] = [];
  const bottom = await prepareDisposalHole(
    bot,
    createMovementPolicy(),
    async ({ position }) => {
      digs.push(position.y);
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    {},
  );
  assert.deepEqual(bottom, new Vec3(1, 62, 0));
  assert.deepEqual(digs, [65, 64, 63, 62]);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "dirt");
});

test("hole evidence counts merged stack growth and ignores existing items", async () => {
  const entity = { id: 1, position: new Vec3(1.5, 62, 0.5), getDroppedItem: () => ({ name: "dirt", count: 2 }) };
  const bot = botFixture({ entities: { 1: entity } });
  const baseline = snapshotDroppedCounts(bot);
  entity.getDroppedItem = () => ({ name: "dirt", count: 12 });
  assert.equal(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
    ),
    true,
  );
  entity.getDroppedItem = () => ({ name: "dirt", count: 2 });
  assert.equal(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
      50,
    ),
    false,
  );
});
