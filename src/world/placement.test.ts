import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { Vec3 } from "vec3";
import { placeBlock, type InventoryItem, type WorldBlock } from "./placement.js";

/** A creative-mode bot with whatever placement surface the test watches. */
const placer = (overrides: Record<string, unknown>) => botFixture({ gameMode: "creative" }, overrides);

test("placement settles the last item before another caller can select the emptied stack", async () => {
  const target = new Vec3(0, 64, 0);
  let count = 1;
  let appeared = false;
  const inventory = Object.assign(new EventEmitter(), {
    items: () => (count > 0 ? [{ name: "cobblestone", count }] : []),
  });
  const bot = placer({
    game: { gameMode: "survival" },
    inventory,
    blockAt: () => ({ name: appeared ? "cobblestone" : "air", position: target }),
    placeBlock: async () => {
      appeared = true;
      setTimeout(() => {
        count = 0;
        inventory.emit("updateSlot");
      }, 30);
    },
  });
  const result = await placeBlock(bot, {
    item: { name: "cobblestone" } as InventoryItem,
    support: { name: "stone", position: target.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [target],
    matches: (block) => block.name === "cobblestone",
  });
  assert.equal(result.kind, "placed");
  assert.equal(count, 0);
});

test("places an oriented block while sneaking and always releases sneak", async () => {
  const target = new Vec3(1, 64, 0);
  let placed = false;
  const controls: boolean[] = [];
  const bot = placer({
    look: async (yaw: number, pitch: number) => {
      assert.equal(yaw, -Math.PI / 2);
      assert.equal(pitch, 0);
    },
    setControlState: (_control: string, state: boolean) => controls.push(state),
    blockAt: () => (placed ? { name: "red_bed", position: target } : { name: "air", position: target }),
    _placeBlockWithOptions: async (_support: unknown, _face: unknown, options: unknown) => {
      assert.deepEqual(options, { forceLook: "ignore", swingArm: "right" });
      placed = true;
    },
  });

  const result = await placeBlock(bot, {
    item: { name: "red_bed" } as InventoryItem,
    support: { name: "stone", position: target.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [target],
    matches: (block) => block.name.endsWith("_bed"),
    lookDirection: new Vec3(1, 0, 0),
  });

  assert.equal(result.kind, "placed");
  assert.deepEqual(controls, [true, false]);
});

test("ordinary placement requests immediate native face aiming", async () => {
  const target = new Vec3(1, 64, 0);
  const support = { name: "stone", position: target.offset(0, -1, 0) } as WorldBlock;
  const face = new Vec3(0, 1, 0);
  let placed = false;
  const controls: boolean[] = [];
  const bot = placer({
    lookAt: async (point: Vec3, force: boolean) => {
      assert.deepEqual(point, new Vec3(1.5, 64, 0.5));
      assert.equal(force, true);
    },
    setControlState: (_control: string, state: boolean) => controls.push(state),
    blockAt: () => ({ name: placed ? "cobblestone" : "air", position: target }),
    placeBlock: async () => {
      throw new Error("Default native placement waits for a smooth turn");
    },
    _placeBlockWithOptions: async (actualSupport: unknown, actualFace: unknown, options: unknown) => {
      assert.equal(actualSupport, support);
      assert.deepEqual(actualFace, face);
      assert.deepEqual(options, { forceLook: "ignore", swingArm: "right" });
      placed = true;
    },
  });
  const result = await placeBlock(bot, {
    item: { name: "cobblestone" } as InventoryItem,
    support,
    face,
    expectedCells: [target],
    matches: (block) => block.name === "cobblestone",
  });
  assert.equal(result.kind, "placed");
  assert.deepEqual(controls, [true, false]);
});

for (const entersDuringAim of [false, true]) {
  test(`full-cube placement refuses an observed body ${entersDuringAim ? "entering during aim" : "already in the cell"}`, async () => {
    const target = new Vec3(0, 64, 0);
    const entity = {
      id: 9,
      name: "wither_skeleton",
      type: "hostile",
      isValid: true,
      width: 0.7,
      height: 2.4,
      position: new Vec3(0.5, 64, entersDuringAim ? 3 : 0.5),
    };
    let packets = 0;
    let equips = 0;
    const bot = placer({
      entities: { 9: entity },
      entity: { id: 1 },
      equip: async () => {
        equips++;
      },
      lookAt: async () => {
        entity.position.z = 0.5;
      },
      _placeBlockWithOptions: async () => {
        packets++;
      },
    });
    const result = await placeBlock(bot, {
      item: { name: "cobblestone" } as InventoryItem,
      support: { position: target.offset(0, -1, 0) } as WorldBlock,
      face: new Vec3(0, 1, 0),
      expectedCells: [target],
      matches: () => true,
    });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.error, /\(0, 64, 0\).*wither_skeleton #9/);
    assert.equal(packets, 0);
    assert.equal(equips, entersDuringAim ? 1 : 0);
  });
}

test("does not accept half of a multi-block placement", async () => {
  const foot = new Vec3(1, 64, 0);
  const head = new Vec3(2, 64, 0);
  const bot = placer({
    blockAt: (position: Vec3) => (position.equals(foot) ? { name: "red_bed", position } : { name: "air", position }),
    _placeBlockWithOptions: async () => {},
  });

  const result = await placeBlock(bot, {
    item: { name: "red_bed" } as InventoryItem,
    support: { name: "stone", position: foot.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [foot, head],
    matches: (block) => block.name.endsWith("_bed"),
    lookDirection: new Vec3(1, 0, 0),
  });

  assert.equal(result.kind, "failed");
});

test("waits for every cell of a multi-block placement", async () => {
  const foot = new Vec3(1, 64, 0);
  const head = new Vec3(2, 64, 0);
  let settled = false;
  const bot = placer({
    waitForTicks: async () => {
      settled = true;
    },
    blockAt: (position: Vec3) =>
      position.equals(foot) || (settled && position.equals(head))
        ? { name: "red_bed", position }
        : { name: "air", position },
    _placeBlockWithOptions: async () => {},
  });

  const result = await placeBlock(bot, {
    item: { name: "red_bed" } as InventoryItem,
    support: { name: "stone", position: foot.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [foot, head],
    matches: (block) => block.name.endsWith("_bed"),
    lookDirection: new Vec3(1, 0, 0),
  });

  assert.equal(result.kind, "placed");
});

test("releases sneak when Mineflayer rejects placement", async () => {
  const controls: boolean[] = [];
  const bot = placer({
    setControlState: (_control: string, state: boolean) => controls.push(state),
    _placeBlockWithOptions: async () => {
      throw new Error("rejected");
    },
  });

  const result = await placeBlock(bot, {
    item: { name: "red_bed" } as InventoryItem,
    support: { name: "stone", position: new Vec3(0, 63, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [new Vec3(0, 64, 0)],
    matches: (block) => block.name.endsWith("_bed"),
    lookDirection: new Vec3(1, 0, 0),
  });

  assert.deepEqual(result, { kind: "failed", error: "rejected" });
  assert.deepEqual(controls, [true, false]);
});

test("uses the 1.21.4 sneaking action before placement against an interactive support", async () => {
  const target = new Vec3(0, 64, 0);
  const protocol: string[] = [];
  let placed = false;
  const bot = placer({
    version: "1.21.4",
    entity: { id: 7 },
    _client: {
      write: (name: string, packet: { actionId?: number }) => protocol.push(`${name}:${packet.actionId}`),
    },
    blockAt: () => (placed ? { name: "furnace", position: target } : { name: "air", position: target }),
    placeBlock: async () => {
      protocol.push("place");
      placed = true;
    },
  });

  const result = await placeBlock(bot, {
    item: { name: "furnace" } as InventoryItem,
    support: { name: "crafting_table", position: target.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [target],
    matches: (block) => block.name === "furnace",
  });

  assert.equal(result.kind, "placed");
  assert.deepEqual(protocol, ["entity_action:0", "place", "entity_action:1"]);
});

test("accepts a physically observed placement after Mineflayer's block-update timeout", async () => {
  const target = new Vec3(0, 64, 0);
  let placed = false;
  const bot = placer({
    blockAt: () => (placed ? { name: "furnace", position: target } : { name: "air", position: target }),
    placeBlock: async () => {
      placed = true;
      throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
    },
  });

  const result = await placeBlock(bot, {
    item: { name: "furnace" } as InventoryItem,
    support: { name: "stone", position: target.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [target],
    matches: (block) => block.name === "furnace",
  });

  assert.equal(result.kind, "placed");
});

test("preserves a block-update timeout with post-timeout world evidence", async () => {
  const target = new Vec3(0, 64, 0);
  let ticks = 0;
  const bot = placer({
    waitForTicks: async () => {
      ticks += 1;
    },
    blockAt: () => ({ name: "air", position: target }),
    placeBlock: async () => {
      throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
    },
  });

  const result = await placeBlock(bot, {
    item: { name: "furnace" } as InventoryItem,
    support: { name: "stone", position: target.offset(0, -1, 0) } as WorldBlock,
    face: new Vec3(0, 1, 0),
    expectedCells: [target],
    matches: (block) => block.name === "furnace",
  });

  assert.deepEqual(result, {
    kind: "failed",
    error:
      "Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms; " +
      "physical verification after 5 ticks observed (0, 64, 0)=air.",
  });
  assert.equal(ticks, 4);
});
