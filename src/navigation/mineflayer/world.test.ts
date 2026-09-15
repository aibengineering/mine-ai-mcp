import { MineflayerWorldView, observeMineflayerBlock } from "./world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";

const registry = minecraftData("1.21.4");
const STONE = registry.blocksByName.stone.defaultState;
const DIRT = registry.blocksByName.dirt.defaultState;

/** A bot double holding one chunk column whose cells are read from a map; counts column reads. */
function columnBot(cells: Map<string, number>) {
  const emitter = new EventEmitter();
  let cellReads = 0;
  const column = {
    minY: -64,
    worldHeight: 384,
    getBlockStateId: (position: Vec3) => {
      cellReads += 1;
      return cells.get(`${position.x},${position.y},${position.z}`) ?? 0;
    },
  };
  const bot = Object.assign(emitter, {
    registry,
    world: { getColumn: (chunkX: number, chunkZ: number) => (chunkX === 0 && chunkZ === 0 ? column : null) },
  }) as unknown as Bot;
  return { bot, emitter, cellReads: () => cellReads };
}

function block(stateId: number, position: Vec3) {
  return { stateId, position } as unknown as NonNullable<ReturnType<Bot["blockAt"]>>;
}

/** One Prismarine block as its own accessors report it, with everything unnamed left plain. */
function prismarineBlock(fields: Record<string, unknown>) {
  return {
    shapes: [],
    boundingBox: "empty",
    diggable: true,
    getProperties: () => ({}),
    ...fields,
  } as unknown as Parameters<typeof observeMineflayerBlock>[0];
}

test("both growing and terminal Nether vine blocks are climbable", () => {
  for (const name of ["weeping_vines", "weeping_vines_plant", "twisting_vines", "twisting_vines_plant"]) {
    assert.equal(observeMineflayerBlock(prismarineBlock({ name })).traits.climbable, true, name);
  }
});

test("a cell is read from Prismarine once, and equal cells share one observation", () => {
  const { bot, cellReads } = columnBot(
    new Map([
      ["4,63,2", STONE],
      ["1,63,1", STONE],
      ["2,63,1", STONE],
    ]),
  );
  const world = new MineflayerWorldView(bot);

  const stone = world.blockAt(4, 63, 2);
  assert.equal(stone.kind, "loaded");
  if (stone.kind === "loaded") assert.equal(stone.stateId, STONE);
  assert.equal(cellReads(), 1);
  world.blockAt(4, 63, 2);
  assert.equal(cellReads(), 1, "the second answer comes from the store");

  const air = world.blockAt(5, 63, 2);
  assert.equal(air.kind === "loaded" && air.stateId, 0);
  assert.equal(cellReads(), 2);
  assert.equal(world.blockAt(40, 63, 2).kind, "unloaded");
  assert.equal(world.blockAt(1, 63, 1), world.blockAt(2, 63, 1), "cells holding the same state are one observation");
  world.close();
});

test("a block update rewrites its stored cell and publishes the change; a column reload drops the section", () => {
  const cells = new Map([["4,63,2", STONE]]);
  const { bot, emitter, cellReads } = columnBot(cells);
  const world = new MineflayerWorldView(bot);
  const changes: number[] = [];
  world.subscribe((change) => changes.push(change.after.kind === "loaded" ? change.after.stateId : -1));
  world.blockAt(4, 63, 2);

  emitter.emit("blockUpdate", block(STONE, new Vec3(4, 63, 2)), block(DIRT, new Vec3(4, 63, 2)));

  const changed = world.blockAt(4, 63, 2);
  assert.equal(changed.kind === "loaded" && changed.stateId, DIRT);
  assert.deepEqual(changes, [DIRT]);
  assert.equal(world.revision, 1);
  assert.equal(cellReads(), 1, "an update carries its own state; the column is not read again");

  // A reload replaces the section wholesale, so the next read goes back to it.
  cells.set("4,63,2", STONE);
  emitter.emit("chunkColumnLoad", new Vec3(0, 0, 0));
  const reloaded = world.blockAt(4, 63, 2);
  assert.equal(reloaded.kind === "loaded" && reloaded.stateId, STONE);
  assert.equal(cellReads(), 2);

  world.close();
  assert.equal(emitter.listenerCount("blockUpdate"), 0);
});

test("block traits are read from Prismarine's own property strings", () => {
  // Prismarine reports the water level as a string, so a numeric comparison
  // would never recognise a source block.
  const water = observeMineflayerBlock(
    prismarineBlock({ stateId: 86, name: "water", getProperties: () => ({ level: "0" }) }),
  );
  assert.equal(water.traits.liquidSource, true);

  // Both halves of a door resolve to one activation group, so opening either
  // names the same passage.
  const upper = observeMineflayerBlock(
    prismarineBlock({
      stateId: 1,
      name: "oak_door",
      shapes: [[0, 0, 0, 1, 1, 0.1875]],
      boundingBox: "block",
      getProperties: () => ({ half: "upper", open: false }),
    }),
  );
  assert.equal(upper.traits.activationGroup, "oak_door");
  assert.equal(upper.traits.upperHalf, true);
  assert.equal(upper.traits.openable, true);
});
