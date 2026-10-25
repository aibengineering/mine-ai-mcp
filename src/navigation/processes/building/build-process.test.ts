import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { packKey } from "../../index.js";
import { structureWorld } from "../../../test-support/structure-world.js";
import { build, enclosesBot, type BuildCell, type BuildRequest, type BuildResult } from "./build-process.js";
import { observation } from "../../../test-support/navigation.js";

const goalTestWorld = new GoalTestWorld();

function cells(list: [number, number, number][], blockName = "cobblestone"): BuildCell[] {
  return list.map(([x, y, z]) => ({ position: { x, y, z }, blockName }));
}

function kinds(result: BuildResult): string[] {
  return result.cells.map(({ state }) => state.kind);
}

/** The shell of a 3×3×3 hollow box whose interior is the bot's own cell column. */
function hollowBox(): [number, number, number][] {
  const shell: [number, number, number][] = [];
  for (let x = 0; x <= 2; x += 1)
    for (let y = 64; y <= 66; y += 1)
      for (let z = 0; z <= 2; z += 1) if (!(x === 1 && z === 1 && y <= 65)) shell.push([x, y, z]);
  return shell;
}

test("places supported cells lowest first from where it stands, and the top row only once its supports exist", async () => {
  const { bot, physics, placements, routes } = structureWorld();
  // A 2-wide, 3-tall pillar pair with a lintel: the lintel needs the pillars first.
  const structure = cells([
    [2, 66, 0],
    [3, 66, 0],
    [2, 64, 0],
    [2, 65, 0],
    [3, 64, 0],
    [3, 65, 0],
  ]);
  const result = await build(bot, { ...physics, cells: structure, removeWrongBlocks: false });

  assert.equal(result.status, "complete");
  assert.deepEqual(placements.slice(0, 2).sort(), ["2,64,0", "3,64,0"]);
  assert.deepEqual(placements.slice(-2).sort(), ["2,66,0", "3,66,0"]);
  assert.deepEqual(routes, [], "everything was within reach");
  assert.equal(result.placed, 6);
});

test("reach, not distance, decides which cells are walked to", async () => {
  for (const row of [
    {
      name: "a cell exactly a reach away is placed where the bot stands, as a route would report it already reached",
      cell: [4, 64, 0] as [number, number, number],
      world: {},
      routes: 0,
    },
    {
      name: "a cell not loaded yet is walked to, and placed once it is",
      cell: [30, 64, 0] as [number, number, number],
      world: { loadedRadius: 8 },
      routes: 1,
    },
  ]) {
    const { bot, physics, routes, placements } = structureWorld(row.world);
    const result = await build(bot, { ...physics, cells: cells([row.cell]), removeWrongBlocks: false });
    assert.equal(result.status, "complete", row.name);
    assert.equal(routes.length, row.routes, row.name);
    assert.deepEqual(placements, [row.cell.join(",")], row.name);
  }
});

test("walks to cells out of reach under one goal that moves on as cells are placed, protecting the cells already right", async () => {
  const { bot, physics, routes, protectedSets, placements } = structureWorld();
  const result = await build(bot, {
    ...physics,
    cells: cells([
      [10, 64, 0],
      [20, 64, 0],
    ]),
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(placements, ["10,64,0", "20,64,0"]);
  assert.equal(routes.length, 2, "one route, two legs: the goal revised itself after the first placement");
  assert.match(routes[0]!, /10,64,0/);
  assert.match(routes[1]!, /^any\(near:20,64,0:4\)$/, "the second leg names only the cell still wrong");
  assert.equal(protectedSets.length, 1, "one policy for the run, over a live set");
  assert.ok(protectedSets[0]!.has(packKey(10, 64, 0)) && protectedSets[0]!.has(packKey(20, 64, 0)));
});

test("a sealed box is finished from outside: the bot walks out before the last block", async () => {
  const feet = new Vec3(1, 64, 1);
  const { bot, physics, routes } = structureWorld({ feet });
  const shell = hollowBox();
  const result = await build(bot, { ...physics, cells: cells(shell), removeWrongBlocks: false });

  assert.equal(result.status, "complete");
  assert.equal(result.placed, shell.length);
  assert.ok(routes.length >= 1, "the bot had to leave the box");
  const finalFeet = bot.entity.position.floored();
  assert.ok(finalFeet.x < 0 || finalFeet.x > 2 || finalFeet.z < 0 || finalFeet.z > 2, `ended outside, at ${finalFeet}`);
});

/**
 * The first-entry End fight of 20 October: a fall saved by water left the bot
 * on a staircase support at -37,87,19, standing in the cell its next tread
 * needed. The way out it was given lay two blocks past the corner of the
 * staircase's bounds at its own height, 87, in the air beside the tower, and
 * every search for it ran out of its 2000 ms: "could not step out of the
 * structure", three requests running. The tread beside it was a step away.
 */
test("a bot standing where a tread belongs steps onto the nearest open stance, not out past the bounds", async () => {
  const { bot, put, physics } = structureWorld({ feet: new Vec3(-37, 87, 19) });
  put(new Vec3(-37, 86, 19), "end_stone");
  put(new Vec3(-38, 86, 19), "end_stone");
  const node = (x: number, y: number, z: number) => ({ feet: { x, y, z }, remainingScaffolds: 0, overlayId: "" });
  let checked = false;
  await build(bot, {
    ...physics,
    cells: cells([[-37, 87, 19], [-37, 88, 20], [-33, 95, 24]], "end_stone"),
    removeWrongBlocks: false,
    route: async ({ goal }) => {
      const resolved = goal.resolve(observation(-37, 87, 19));
      assert.equal(resolved.kind, "active");
      if (resolved.kind === "active") {
        assert.equal(resolved.isSatisfied(node(-38, 87, 19), goalTestWorld), true, "the tread beside it is a way out");
        assert.equal(resolved.isSatisfied(node(-37, 87, 19), goalTestWorld), false, "its own cell is not");
        checked = true;
      }
      return { status: "stopped", reason: "checked", elapsedMs: 0 };
    },
  });
  assert.ok(checked, "the bot was asked to step out");
});

/**
 * A step-out route that ends without moving the bot, because its goal already
 * held where the bot stood or the body never left the cell, sent the build
 * straight back to the same step-out. Each pass awaited only a route that
 * settled at once, so the loop never yielded: a live End client stopped
 * answering the server mid-staircase and was timed out.
 */
test("a step-out that leaves the bot where it was stops the build instead of spinning", async () => {
  const { bot, physics } = structureWorld({ feet: new Vec3(2, 64, 0) });
  let routes = 0;
  const result = await build(bot, {
    ...physics,
    cells: cells([[2, 64, 0], [3, 64, 0]]),
    removeWrongBlocks: false,
    route: async () => {
      if (++routes > 100) throw new Error("the build spun on a step-out that never moved the bot");
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "stopped");
  assert.match(String(result.reason), /could not step out of the structure/);
  assert.ok(routes <= 3, `${routes} step-out routes`);
});

test("enclosesBot reads a roofed box as sealed and a doorway as open", () => {
  const { bot, put } = structureWorld({ feet: new Vec3(1, 64, 1) });
  const filled = new Set(hollowBox().map(([x, y, z]) => packKey(x, y, z)));
  const bounds = { min: new Vec3(0, 64, 0), max: new Vec3(2, 66, 2) };
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), true);
  filled.delete(packKey(0, 64, 1));
  filled.delete(packKey(0, 65, 1));
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), false);
  put(new Vec3(-1, 64, 1), "stone");
  put(new Vec3(-1, 65, 1), "stone");
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), true, "a wall beyond the doorway seals it again");
});

/**
 * A cell the run cannot place is named by its own state rather than by a
 * whole-run reason, and the run gives up on it instead of passing over it
 * forever.
 *
 * The unsupported row is the live portal call of 3 September: the two
 * top-middle cells of a frame whose corners were missing, so nothing was beside
 * or below them to place against. The audit said "2 cells still wrong" in 0 ms.
 */
test("a cell that cannot be placed is reported by its own state, and the run stops without spinning", async () => {
  const refusal = "the server did not update the block";
  const refuse: BuildRequest["place"] = async () => ({ kind: "failed", error: refusal });
  const pair: [number, number, number][] = [
    [2, 64, 0],
    [3, 64, 0],
  ];
  const lintel: [number, number, number][] = [
    [2, 67, 0],
    [3, 67, 0],
  ];
  for (const row of [
    {
      name: "not carried",
      world: { carried: { cobblestone: 1 } },
      cells: cells(pair),
      place: null,
      kinds: ["correct", "not_carried"],
      placed: 1,
      stateReason: null,
    },
    {
      name: "nothing to place against",
      world: {},
      cells: cells(lintel, "obsidian"),
      place: null,
      kinds: ["unsupported", "unsupported"],
      placed: 0,
      stateReason: null,
    },
    {
      name: "the server refuses the placement",
      world: {},
      cells: cells(pair),
      place: refuse,
      kinds: ["refused", "refused"],
      placed: 0,
      stateReason: refusal,
    },
  ]) {
    const { bot, physics, placements } = structureWorld(row.world);
    const result = await build(bot, {
      ...physics,
      ...(row.place && { place: row.place }),
      cells: row.cells,
      removeWrongBlocks: false,
    });
    assert.equal(result.status, "stopped", row.name);
    assert.equal(result.reason, null, `${row.name}: the cell states say why`);
    assert.deepEqual(kinds(result), row.kinds, row.name);
    assert.equal(result.placed, row.placed, row.name);
    assert.equal(placements.length, row.placed, row.name);
    assert.ok(result.passes <= 4, `${row.name}: passes ${result.passes}`);
    if (row.stateReason !== null)
      assert.equal((result.cells[0]!.state as { reason: string }).reason, row.stateReason, row.name);
  }
});

/**
 * The live shelter call of 3 September: the upper wall cells held leaves, the
 * request left wrong blocks alone, and the audit said only "4 cells still
 * wrong". The state has to name the block so the next request can ask to dig it.
 */
test("a wrong block is reported by name when left, and dug first when asked", async () => {
  const { bot, put, physics } = structureWorld();
  put(new Vec3(2, 64, 0), "oak_leaves");
  const left = await build(bot, { ...physics, cells: cells([[2, 64, 0]]), removeWrongBlocks: false });
  assert.equal(left.status, "stopped");
  assert.deepEqual(left.cells[0]!.state, { kind: "blocked", holds: "oak_leaves" });

  const replaced = await build(bot, { ...physics, cells: cells([[2, 64, 0]]), removeWrongBlocks: true });
  assert.equal(replaced.status, "complete");
  assert.equal(replaced.dug, 1);
  assert.equal(replaced.placed, 1);
});

test("a hidden wrong block is approached from a visible stance instead of permanently refused", async () => {
  const { bot, put, physics, routes } = structureWorld({ feet: new Vec3(3, 64, 0) });
  put(new Vec3(2, 64, 0), "oak_leaves");
  const result = await build(bot, {
    ...physics,
    canSeeDig: (_target, standing) => standing.x < 1,
    breakInPlace: async (request) => {
      assert.ok(bot.entity.position.x < 1, "never attempt the hidden dig");
      return physics.breakInPlace(request);
    },
    route: async (request) => {
      const goal = request.goal.resolve(observation());
      assert.equal(goal.kind, "active");
      if (goal.kind === "active") {
        assert.equal(
          goal.isSatisfied({ feet: { x: 3, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
          false,
        );
        assert.equal(
          goal.isSatisfied({ feet: { x: 0, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
          true,
        );
      }
      return physics.route(request);
    },
    cells: cells([[2, 64, 0]]),
    removeWrongBlocks: true,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dug, 1);
  assert.equal(result.placed, 1);
  assert.equal(routes.length, 1);
});

/**
 * The End staircase of 20 October, moved onto this floor 10 east, 1 up and 36
 * south. A route dropped the bot at 4.46,64,1.62, in the cell whose centre
 * sees the clearance cell at 1,63,0 but 0.12 blocks off it, where the bot
 * stood, the ray clipped the ground beside it. The goal said "arrived" from
 * the centre, the work in reach found nothing from the body, and every pass
 * and every retry ended there without moving: "2 passes changed nothing".
 */
test("the cell the bot stands in is judged from the body, not its centre, so arrival and work agree", async () => {
  const { bot, physics } = structureWorld({ feet: new Vec3(4, 64, 1) });
  bot.entity.position = new Vec3(4.46, 64, 1.62);
  const centred = (standing: { x: number; z: number }) =>
    Math.abs(standing.x - Math.floor(standing.x) - 0.5) < 0.01 && Math.abs(standing.z - Math.floor(standing.z) - 0.5) < 0.01;
  const here = () => ({ ...observation(), position: bot.entity.position.clone() });
  const node = (feet: Vec3) => ({ feet: { x: feet.x, y: feet.y, z: feet.z }, remainingScaffolds: 0, overlayId: "" });
  const result = await build(bot, {
    ...physics,
    canSeeDig: (_target, standing) => centred(standing),
    breakInPlace: async (request) => {
      assert.ok(centred(bot.entity.position), `dug only where the face is seen, not at ${bot.entity.position}`);
      return physics.breakInPlace(request);
    },
    // The navigator's arrival rule: a goal satisfied where the bot stands ends
    // the leg there; otherwise walk to the centre of the nearest cell it accepts.
    route: async ({ goal, onArrival }) => {
      for (let legs = 0; legs < 8; legs += 1) {
        const resolved = goal.resolve(here());
        if (resolved.kind !== "active") return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
        const feet = bot.entity.position.floored();
        if (!resolved.isSatisfied(node(feet), goalTestWorld)) {
          const stances: Vec3[] = [];
          for (let x = -3; x <= 3; x += 1) for (let z = -3; z <= 3; z += 1) stances.push(feet.offset(x, 0, z));
          const stance = stances.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet))
            .find((cell) => resolved.isSatisfied(node(cell), goalTestWorld));
          if (!stance) return { status: "stopped", reason: "no stance", elapsedMs: 0 };
          bot.entity.position = stance.offset(0.5, 0, 0.5);
        }
        const decision = onArrival ? await onArrival({ signal: undefined } as never) : { kind: "completed" };
        if (decision.kind === "completed") return { status: "completed", elapsedMs: 0 };
      }
      return { status: "stopped", reason: "the fake route ran out of legs", elapsedMs: 0 };
    },
    cells: cells([[1, 63, 0]], "air"),
    removeWrongBlocks: true,
  });
  assert.equal(result.status, "complete", String(result.reason));
  assert.equal(result.dug, 1);
});

/**
 * The live portal of 3 September had cobblestone scaffolded up through its
 * interior, which a portal cannot be lit through. A cell asked to be air is
 * dug whether or not wrong blocks may be removed elsewhere, and it is never
 * counted as short of anything.
 */
test("a cell asked to be air is dug clear without being asked to remove wrong blocks", async () => {
  const { bot, put, physics } = structureWorld();
  put(new Vec3(2, 64, 0), "cobblestone");
  put(new Vec3(3, 64, 0), "cobblestone");
  const result = await build(bot, {
    ...physics,
    cells: [...cells([[2, 64, 0]], "air"), ...cells([[3, 64, 0]])],
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dug, 1);
  assert.equal(result.placed, 0);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))!.name, "air");
});

test("a route that cannot reach a cell refuses that cell and carries on with the rest", async () => {
  const { bot, physics, placements } = structureWorld();
  let stopped = false;
  const result = await build(bot, {
    ...physics,
    route: async (options) => {
      if (!stopped) {
        stopped = true;
        return { status: "stopped", reason: "no path; closest node was 5,64,0", elapsedMs: 0 };
      }
      return physics.route(options);
    },
    cells: cells([
      [10, 64, 0],
      [12, 64, 0],
    ]),
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, null);
  assert.equal(placements.length, 1, "the other cell was still built");
  assert.ok(kinds(result).includes("refused"));
  assert.ok(kinds(result).includes("correct"));
});
