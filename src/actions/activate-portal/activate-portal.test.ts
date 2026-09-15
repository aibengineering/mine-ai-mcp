import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { activatePortal, type ActivatePortalDependencies } from "./activate-portal.js";
import { parseActivatePortalRequest, activatePortalResultSchema } from "./contract.js";
import { endFrameAt, findEndFrame, outsideEndOpening } from "./end-frame.js";
import { findNetherFrame } from "./nether-frame.js";

const goalTestWorld = new GoalTestWorld();

function world() {
  const blocks = new Map<
    string,
    { name: string; position: Vec3; getProperties: () => Record<string, string | boolean> }
  >();
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const put = (p: Vec3, name: string, properties: Record<string, string | boolean> = {}) =>
    blocks.set(key(p), { name, position: p, getProperties: () => properties });
  const items = [
    { name: "ender_eye", count: 12 },
    { name: "flint_and_steel", count: 1 },
  ];
  const bot = {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0.5, 64, -3.5) },
    inventory: { items: () => items.filter((item) => item.count > 0) },
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? { name: "air", position: p, getProperties: () => ({}) },
  } as unknown as Bot;
  const uses: Vec3[] = [];
  const frame = endFrameAt(new Vec3(0, 64, 0));
  const dependencies: ActivatePortalDependencies = {
    createMovements: () => ({}) as never,
    navigate: async ({ goal }) => {
      const resolved = goal.resolve({ position: bot.entity.position } as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("inactive goal");
      for (let x = -5; x <= 15; x += 1)
        for (let z = -5; z <= 5; z += 1) {
          if (resolved.isSatisfied({ feet: { x, y: 64, z }, remainingScaffolds: 0, overlayId: "0" }, goalTestWorld)) {
            bot.entity.position = new Vec3(x + 0.5, 64, z + 0.5);
            return { status: "completed", elapsedMs: 0 };
          }
        }
      throw new Error("no permitted approach");
    },
    useItem: async (_bot, use) => {
      const block = use.on!.block;
      uses.push(block.position.clone());
      if (block.name === "end_portal_frame") {
        assert.ok(outsideEndOpening(frame, bot.entity.position), "never insert an eye from inside the opening");
        put(block.position, block.name, { ...block.getProperties(), eye: true });
        items[0]!.count -= 1;
        if (frame.sockets.every(({ position }) => bot.blockAt(position)!.getProperties().eye === true))
          for (const cell of frame.interior) put(cell, "end_portal");
      } else {
        assert.equal(block.name, "obsidian");
        assert.deepEqual(use.on!.face, { x: 0, y: 1, z: 0 });
        for (const cell of use.expectedCells ?? [])
          put(new Vec3(cell.position.x, cell.position.y, cell.position.z), "nether_portal");
      }
      return { kind: "used" };
    },
  };
  const end = (filled = 0) =>
    frame.sockets.forEach(({ position, facing }, index) =>
      put(position, "end_portal_frame", { facing, eye: index < filled }),
    );
  const nether = (axis: "x" | "z") => {
    const at = (along: number, y: number) => (axis === "x" ? new Vec3(along, y, 0) : new Vec3(0, y, along));
    for (const along of [10, 11]) for (const y of [63, 67]) put(at(along, y), "obsidian");
    for (const along of [9, 12]) for (const y of [64, 65, 66]) put(at(along, y), "obsidian");
  };
  return { bot, dependencies, uses, frame, put, items, end, nether };
}

test("portal contract accepts coordinates and rejects invented portal-type flags", () => {
  assert.deepEqual(parseActivatePortalRequest({ x: 1, y: -20, z: 3 }), { x: 1, y: -20, z: 3 });
  assert.throws(() => parseActivatePortalRequest({ x: 1, y: 2, z: 3, type: "end" }));
  assert.throws(() => parseActivatePortalRequest({ x: 0.5, y: 2, z: 3 }));
});

test("Nether frame detection accepts frame blocks and interior cells on both axes, without corners", () => {
  for (const axis of ["x", "z"] as const) {
    const { bot, nether, put } = world();
    nether(axis);
    const at = (along: number, y: number) => (axis === "x" ? new Vec3(along, y, 0) : new Vec3(0, y, along));
    for (const cell of [at(10, 63), at(9, 65), at(11, 67), at(11, 66)]) {
      const found = findNetherFrame(bot, cell);
      assert.ok("frame" in found);
      assert.equal(found.frame.axis, axis);
      assert.equal(found.frame.width * found.frame.height, 6);
    }
    put(at(12, 65), "air");
    assert.ok("reason" in findNetherFrame(bot, at(10, 64)));
  }
});

test("Nether activation needs flint only while the portal is dark, and observes six cells", async () => {
  const { bot, nether, dependencies, uses, items } = world();
  nether("x");
  const request = { x: 10, y: 63, z: 0 };
  items[1]!.count = 0;
  const missing = await activatePortal(bot, request, {}, dependencies);
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /PORTAL_NO_FLINT_AND_STEEL/);
  assert.equal(uses.length, 0, "a refusal spends nothing");

  items[1]!.count = 1;
  const output = await activatePortal(bot, request, {}, dependencies);
  activatePortalResultSchema.parse(output);
  assert.equal(output.status, "succeeded");
  assert.ok(output.portal.kind === "nether" && output.portal.activated && output.portal.portalAfter === 6);
  assert.deepEqual(uses, [new Vec3(10, 63, 0)]);
  items[1]!.count = 0;
  const again = await activatePortal(bot, request, {}, dependencies);
  assert.equal(again.status, "succeeded");
  assert.ok(again.portal.kind === "nether" && !again.portal.activated);
  assert.equal(uses.length, 1);
});

test("End discovery requires all twelve inward-facing frames from every socket", () => {
  const { bot, end, frame, put } = world();
  end();
  for (const socket of frame.sockets) assert.deepEqual(findEndFrame(bot, socket.position)?.center, frame.center);
  const first = frame.sockets[0]!;
  put(first.position, "end_portal_frame", { facing: "north", eye: false });
  assert.equal(findEndFrame(bot, frame.sockets[1]!.position), null);
});

test("End activation refuses insufficient eyes before spending any", async () => {
  const { bot, end, frame, dependencies, items, uses } = world();
  end(4);
  items[0]!.count = 7;
  const output = await activatePortal(bot, frame.sockets[0]!.position, {}, dependencies);
  assert.equal(output.status, "failed");
  assert.ok(output.error.includes("8 empty sockets; 7"));
  assert.equal(uses.length, 0);
});

test("cancel after an insertion, recreate execution, and fill only the remaining sockets from outside", async () => {
  const { bot, end, frame, dependencies, items, uses } = world();
  end(4);
  items[0]!.count = 8;
  // The centre of this feet cell is safe, but the actual body overlaps the opening.
  bot.entity.position = frame.center.offset(2.1, 0, 0.5);
  const stop = new AbortController();
  const use = dependencies.useItem;
  const request = { ...frame.sockets[0]!.position };
  await assert.rejects(
    activatePortal(
      bot,
      request,
      { signal: stop.signal },
      {
        ...dependencies,
        useItem: async (...args) => {
          const result = await use(...args);
          stop.abort();
          return result;
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(items[0]!.count, 7);
  const resumed = await activatePortal(bot, request, {}, dependencies);
  activatePortalResultSchema.parse(resumed);
  assert.equal(resumed.status, "succeeded");
  assert.ok(
    resumed.portal.kind === "end" &&
      resumed.portal.eyesBefore === 5 &&
      resumed.portal.eyesAfter === 12 &&
      resumed.portal.portalAfter === 9,
  );
  assert.equal(items[0]!.count, 0);
  assert.equal(new Set(uses.map(String)).size, 8);
  const again = await activatePortal(bot, request, {}, dependencies);
  assert.equal(again.status, "succeeded");
  assert.equal(uses.length, 8);
});

/**
 * A `used` acknowledgement says the server accepted the click, not that a
 * portal exists. Each row leaves the world without portal blocks.
 */
const unlitFrames = [
  {
    name: "an End frame one eye short, the twelfth insertion only acknowledged",
    build: (w: ReturnType<typeof world>) => w.end(11),
    request: (w: ReturnType<typeof world>) => w.frame.sockets[0]!.position,
    acknowledgeOnly: true,
    eyesAfter: 11,
  },
  {
    name: "an End frame with all twelve eyes but no portal behind them",
    build: (w: ReturnType<typeof world>) => w.end(12),
    request: (w: ReturnType<typeof world>) => w.frame.sockets[0]!.position,
    acknowledgeOnly: false,
    eyesAfter: 12,
  },
  {
    name: "a Nether frame whose flint use is only acknowledged",
    build: (w: ReturnType<typeof world>) => w.nether("x"),
    request: () => ({ x: 10, y: 63, z: 0 }),
    acknowledgeOnly: true,
    eyesAfter: null,
  },
] as const;

test("only observed portal blocks establish an active portal, never a use acknowledgement", async () => {
  for (const row of unlitFrames) {
    const w = world();
    row.build(w);
    const output = await activatePortal(
      w.bot,
      row.request(w),
      {},
      {
        ...w.dependencies,
        ...(row.acknowledgeOnly ? { useItem: async () => ({ kind: "used" as const }) } : {}),
      },
    );

    assert.equal(output.status, "failed", row.name);
    if (output.portal.kind === "unresolved") assert.fail(`${row.name}: the frame itself must be resolved`);
    assert.equal(output.portal.portalAfter, 0, row.name);
    if (output.portal.kind === "end") assert.equal(output.portal.eyesAfter, row.eyesAfter, row.name);
    if (!row.acknowledgeOnly) assert.equal(w.uses.length, 0, `${row.name}: nothing is spent`);
  }
});

test("an insertion followed by a failed use reports partial socket progress", async () => {
  const { bot, end, frame, dependencies } = world();
  end(10);
  const output = await activatePortal(
    bot,
    frame.sockets[0]!.position,
    {},
    {
      ...dependencies,
      useItem: async (...args) => {
        await dependencies.useItem(...args);
        return { kind: "failed", error: "Fixture stopped after the block update." };
      },
    },
  );
  activatePortalResultSchema.parse(output);
  assert.equal(output.status, "partial");
  assert.ok(
    output.portal.kind === "end" &&
      output.portal.eyesBefore === 10 &&
      output.portal.eyesAfter === 11 &&
      output.portal.portalAfter === 0,
  );
});
