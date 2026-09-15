/**
 * Which movement families the catalogue offers, as a table.
 *
 * Every row is one shape of the column a step leads into, read with and
 * without a scaffold in the pockets. The point is the whole offered set, not
 * one movement: the bug this table exists for was a placement edge silently
 * removing the plain drop beneath it, so a bot carrying cobblestone had no
 * drop anywhere in its graph and descended an open staircase by digging the
 * floor out from under every tread. Nothing in the offered set asserted that,
 * because every individual movement still looked right.
 */
import { MemoryWorld } from "../world/memory-world.js";
import { createMovementCatalogue } from "./catalogue.js";
import { createMovementPolicy } from "./policy.js";
import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, planningStart } from "../../test-support/navigation.js";

const SOLID = { stateId: 1 } as const;
const AIR = { stateId: 0 } as const;
const COBBLESTONE = { itemType: 35, stateId: 14 } as const;

/**
 * A 3x3 pillar of rock at y 60..70 with the bot's own cell open at y 64, and
 * the column one step east (x 1) carved to order. Everything else is solid, so
 * only the east step has anything to offer.
 */
function world(east: readonly (readonly [number, typeof AIR | typeof SOLID])[]): MemoryWorld {
  const memory = new MemoryWorld();
  for (let x = -2; x <= 3; x += 1)
    for (let z = -2; z <= 2; z += 1) for (let y = 58; y <= 72; y += 1) memory.load({ x, y, z }, SOLID);
  memory.load({ x: 0, y: 64, z: 0 }, AIR);
  memory.load({ x: 0, y: 65, z: 0 }, AIR);
  memory.load({ x: 0, y: 66, z: 0 }, AIR);
  for (const [y, block] of east) memory.load({ x: 1, y, z: 0 }, block);
  return memory;
}

/** The families offered for the step east, as `kind@destination`, sorted. */
function offered(memory: MemoryWorld, scaffolds: number): string[] {
  const policy = createMovementPolicy(scaffolds > 0 ? { scaffold: COBBLESTONE } : {});
  return createMovementCatalogue()
    .generate(
      planningStart({ x: 0, y: 64, z: 0 }, scaffolds),
      { world: memory, policy, player: WELL_FED },
      { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} },
    )
    .toArray()
    .filter((movement) => movement.step.to.x === 1)
    .map((movement) => {
      const places = movement.step.operations.some((operation) => operation.kind === "place");
      return `${movement.step.kind}${places ? "+place" : ""}@${movement.step.to.y}`;
    })
    .sort();
}

/** Each row: the east column's open cells, then what an empty bot and a carrying bot may do. */
const TABLE = [
  {
    shape: "a floor level with the bot",
    east: [
      [64, AIR],
      [65, AIR],
    ],
    // The dug descent is always on offer: it opens the tread it steps down to.
    empty: ["drop@63", "sprint@64"],
    carrying: ["drop@63", "sprint@64", "step_up+place@65"],
  },
  {
    shape: "a tread one block up",
    east: [
      [65, AIR],
      [66, AIR],
    ],
    empty: ["drop@63", "sprint@64", "step_up@65"],
    carrying: ["drop@63", "sprint@64", "step_up@65"],
  },
  {
    shape: "a one-block step down",
    east: [
      [63, AIR],
      [64, AIR],
      [65, AIR],
    ],
    // Carrying cobblestone adds bridging across the edge and stepping onto a
    // placed block. It must not remove the drop: that is the staircase bug,
    // where a bot with cobblestone in its pockets had no plain drop anywhere
    // in its graph and dug the floor out from under every tread instead.
    empty: ["drop@63"],
    carrying: ["drop@63", "step_up+place@65", "walk+place@64"],
  },
  {
    shape: "a three-block drop",
    east: [
      [61, AIR],
      [62, AIR],
      [63, AIR],
      [64, AIR],
      [65, AIR],
    ],
    empty: ["drop@61"],
    carrying: ["drop@61", "step_up+place@65", "walk+place@64"],
  },
  {
    shape: "solid rock",
    east: [],
    // Nothing is open, so every way east is dug: a step down into a tread this
    // movement opens, a traverse straight through, and a step onto the top.
    empty: ["drop@63", "sprint@64", "step_up@65"],
    carrying: ["drop@63", "sprint@64", "step_up@65"],
  },
] as const;

for (const row of TABLE) {
  test(`the catalogue offers the same families into ${row.shape} whether or not it carries scaffold`, () => {
    const memory = world(row.east);
    assert.deepEqual(offered(memory, 0), [...row.empty], "empty-handed");
    assert.deepEqual(offered(memory, 64), [...row.carrying], "carrying cobblestone");
    // Whatever a scaffold adds, it never takes a family away.
    for (const family of offered(memory, 0)) {
      assert.ok(offered(memory, 64).includes(family), `carrying cobblestone lost ${family} into ${row.shape}`);
    }
  });
}
