import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld, observation, planningStart, WELL_FED } from "../../test-support/navigation.js";
import { excavateGoal } from "../goals/excavate.js";
import { createMovementCatalogue } from "./catalogue.js";
import { DIG_REACH, prepareExcavation, stanceSight } from "./excavation.js";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../world/block-visibility.js";
import { obstaclesOf, worldViewRaycaster } from "../world/line-of-sight.js";
import { MemoryWorld } from "../world/memory-world.js";
import type { BlockPosition, Position3 } from "../world/world.js";
import { createMovementPolicy } from "./policy.js";

function excavationWorld() {
  const world = flatWorld();
  for (let x = -2; x <= 2; x += 1)
    for (let z = -2; z <= 2; z += 1) for (let y = 66; y <= 72; y += 1) world.load({ x, y, z }, { stateId: 0 });
  return world;
}

const dry = { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} };
/** The stance every fixture digs from unless it names another. */
const STANCE = { x: 0.5, y: 63, z: 0.5 };

test("opening a water pocket from beside its lid preserves the miner's own dry support", () => {
  const world = excavationWorld();
  const target = { x: 0, y: 62, z: 0 };
  world.load(target, { stateId: 1 });
  world.load({ x: 0, y: 61, z: 0 }, { stateId: 2, collisionShapes: [], traits: { empty: true, liquid: "water", liquidSource: true } });
  assert.match(refusal(prepare(world, target)), /dry footing above water/);
  assert.equal(prepare(world, target, { standing: { x: 1.5, y: 63, z: 0.5 } }).kind, "prepared");
});

test("stationary mining does not wake a suspended gravel floor beneath its stance", () => {
  const world = excavationWorld();
  const target = { x: 1, y: 63, z: 0 };
  world.load(target, { stateId: 1 });
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 124, traits: { falling: true } });
  world.load({ x: 0, y: 61, z: 0 }, { stateId: 0 });
  assert.match(refusal(prepare(world, target)), /no observed stable support/);
  world.load({ x: 0, y: 61, z: 0 }, { stateId: 1 });
  assert.equal(prepare(world, target).kind, "prepared");
});

/** Prepare the excavation of one cell, at the shipped prices unless the fixture names others. */
function prepare(
  world: MemoryWorld,
  position: BlockPosition,
  options: { standing?: Position3; policy?: ReturnType<typeof createMovementPolicy> } = {},
) {
  return prepareExcavation({
    world,
    position,
    standing: options.standing ?? STANCE,
    policy: options.policy ?? createMovementPolicy(),
    digContext: dry,
  });
}

/** The prepared plan, asserting the work is executable from that stance. */
function prepared(result: ReturnType<typeof prepare>) {
  if (result.kind !== "prepared") throw new Error(`Expected ordered excavation, not: ${result.reason}`);
  return result;
}

/** The refusal and its reason, asserting the work is not executable. */
function refusal(result: ReturnType<typeof prepare>): string {
  if (result.kind !== "unavailable") throw new Error("Expected a refusal, but the excavation was prepared.");
  return result.reason;
}

/** The order the column comes down in: each dig's height and what it brings with it. */
function columnOrder(result: ReturnType<typeof prepared>) {
  return result.digs.map((dig) => [dig.position.y, dig.brings.map((brought) => brought.y)]);
}

test("a passable diggable target contributes a real priced break", () => {
  const world = excavationWorld();
  const target = { x: 2, y: 64, z: 0 };
  world.load(target, { stateId: 2047, collisionShapes: [], traits: { empty: true, safeToBreak: true } });

  const result = prepared(prepare(world, target));
  assert.equal(result.digs.length, 1);
  assert.equal(result.digs[0]?.stateId, 2047);
  assert.deepEqual(result.digs[0]?.position, target);
  assert.ok(result.breakTicks > 0);

  // Walking through the same passable cell is not a break at all.
  const traversal = createMovementCatalogue()
    .generate(planningStart({ x: 1, y: 63, z: 0 }), { world, policy: createMovementPolicy(), player: WELL_FED }, dry)
    .toArray()
    .find((movement) => movement.step.to.x === 2 && movement.step.to.y === 63 && movement.step.to.z === 0);
  assert.ok(traversal);
  assert.equal(
    traversal.step.operations.some((operation) => operation.kind === "break"),
    false,
  );
});

test("collection and traversal charge each dig of the same falling column exactly once", () => {
  const world = excavationWorld();
  const target = { x: 1, y: 63, z: 0 };
  world.load(target, { stateId: 1 });
  for (const y of [64, 65]) world.load({ x: 1, y, z: 0 }, { stateId: 2, traits: { falling: true } });
  const policy = createMovementPolicy({
    allowSprinting: false,
    evaluateBreak: () => ({
      decision: { kind: "penalized", reason: "terrain", cost: 2 },
      tool: { itemType: 7, expectedTicks: 10 },
    }),
  });
  const state = planningStart({ x: 0, y: 63, z: 0 });
  const context = { world, policy, player: WELL_FED };
  const goal = excavateGoal(target).resolve(observation());
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("expected excavation goal");

  const collection = goal.finish?.(state, context, dry);
  assert.ok(collection);
  const traverse = createMovementCatalogue()
    .generate(state, context, dry)
    .toArray()
    .find(
      (movement) =>
        movement.step.kind === "walk" &&
        movement.step.to.x === 1 &&
        movement.step.to.y === 63 &&
        movement.step.to.z === 0,
    );
  assert.ok(traverse);
  assert.deepEqual(
    collection.step.operations.filter((op) => op.kind === "break"),
    traverse.step.operations.filter((op) => op.kind === "break"),
  );
  assert.equal(collection.cost, 36);
  assert.equal(traverse.cost - policy.movementTicks.walk, collection.cost);
});

test("a column beside the bot comes down from the top; from underneath, its support is refused", () => {
  const world = excavationWorld();
  const target = { x: 0, y: 65, z: 0 };
  world.load(target, { stateId: 1 });
  world.load({ x: 0, y: 66, z: 0 }, { stateId: 2, traits: { falling: true } });

  const beside = prepared(prepare(world, target, { standing: { x: 1.5, y: 63, z: 0.5 } }));
  assert.deepEqual(
    beside.digs.map((dig) => dig.position.y),
    [66, 65],
  );
  // From directly below, the sand is hidden behind the coal, and taking the
  // coal first would drop the sand onto the bot.
  assert.match(refusal(prepare(world, target)), /would drop the falling block above it onto the bot/);
});

test("a falling column is taken from its highest reachable block, which brings the hidden remainder down", () => {
  const tall = excavationWorld();
  const target = { x: 1, y: 63, z: 0 };
  tall.load(target, { stateId: 1 });
  for (let y = 64; y <= 70; y += 1) tall.load({ x: 1, y, z: 0 }, { stateId: 2, traits: { falling: true } });
  tall.load({ x: 1, y: 71, z: 0 }, { stateId: 0 });
  assert.deepEqual(columnOrder(prepared(prepare(tall, target))), [
    [69, [70]],
    [68, []],
    [67, []],
    [66, []],
    [65, []],
    [64, []],
    [63, []],
  ]);

  // A plug across a corridor is opened at head height, and the sand a ceiling
  // hides from every stance in the corridor is brought down by that dig.
  const corridor = excavationWorld();
  for (const y of [65, 66]) corridor.load({ x: 0, y, z: 0 }, { stateId: 3 });
  for (const y of [63, 64, 65, 66]) corridor.load({ x: 1, y, z: 0 }, { stateId: 2, traits: { falling: true } });
  const plug = prepared(
    prepare(corridor, target, {
      policy: createMovementPolicy({
        evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: 7, expectedTicks: 10 } }),
      }),
    }),
  );
  assert.deepEqual(columnOrder(plug), [
    [64, [65, 66]],
    [63, []],
  ]);
  // The whole column is charged even though only two digs are planned.
  assert.equal(plug.breakTicks, 40);
  assert.equal(plug.digs[0]?.expectedTicks, 30);
});

test("a dig the eye cannot see or the arm cannot reach is not executable work, however near it is", () => {
  const world = excavationWorld();
  const target = { x: 2, y: 63, z: 0 };
  world.load(target, { stateId: 1 });
  // A knee-high lip between them leaves the top face in view over it.
  world.load({ x: 1, y: 63, z: 0 }, { stateId: 3 });
  assert.equal(prepare(world, target).kind, "prepared");
  // A wall two high hides every face.
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 3 });
  assert.match(refusal(prepare(world, target)), /cannot be seen within reach/);

  const far = excavationWorld();
  for (let x = 1; x <= 7; x += 1) for (const y of [63, 64]) far.load({ x, y, z: 0 }, { stateId: 0 });
  const distant = { x: 7, y: 63, z: 0 };
  far.load(distant, { stateId: 1 });
  assert.equal(prepare(far, distant).kind, "unavailable");
});

/**
 * The live failure: collecting dirt, the bot stood in a hole and search
 * "finished" the goal by digging the dirt through the stone beside it. The
 * server obliged, the drop landed in a sealed pocket, and the bot tunnelled
 * stone after it. A stance that cannot see the target must not complete the
 * excavation goal, however near the target is.
 */
test("the excavation goal cannot be finished from a stance that cannot see the target", () => {
  const world = excavationWorld();
  const dirt = { x: 2, y: 63, z: 0 };
  world.load(dirt, { stateId: 1 });
  const wall = [
    { x: 1, y: 63, z: 0 },
    { x: 1, y: 64, z: 0 },
  ];
  for (const cell of wall) world.load(cell, { stateId: 3 });
  const state = planningStart({ x: 0, y: 63, z: 0 });
  const context = { world, policy: createMovementPolicy(), player: WELL_FED };
  const goal = excavateGoal(dirt).resolve(observation());
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("expected excavation goal");

  // 2.1 blocks away, well inside reach, and walled off.
  assert.equal(goal.finish?.(state, context, dry), null);
  // The same stance with the wall gone finishes the goal by digging the dirt.
  for (const cell of wall) world.load(cell, { stateId: 0 });
  const completion = goal.finish?.(state, context, dry);
  assert.ok(completion);
  assert.deepEqual(
    completion.step.operations.filter((op) => op.kind === "break").map((op) => op.position),
    [dirt],
  );
});

test("the ray's known path agrees with the ray itself over random terrain", () => {
  // The path an eye ray crosses to a full-cube target depends only on the
  // target's offset from a centred stance, so `stanceSight` checks that path
  // by lookup and only casts the ray when a partial block lies on it. Both
  // answers must agree, whatever stands between.
  let seed = 20260908;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const SLAB = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }];
  const CARPET = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.0625, maxZ: 1 }];
  const FENCE = [{ minX: 0.375, minY: 0, minZ: 0.375, maxX: 0.625, maxY: 1.5, maxZ: 0.625 }];
  const eye = { x: STANCE.x, y: STANCE.y + STANDING_EYE_HEIGHT, z: STANCE.z };
  let compared = 0;
  for (let round = 0; round < 40; round += 1) {
    const world = new MemoryWorld();
    for (let x = -6; x <= 6; x += 1)
      for (let y = 57; y <= 70; y += 1)
        for (let z = -6; z <= 6; z += 1) {
          const roll = random();
          const block =
            roll < 0.45
              ? { stateId: 0 }
              : roll < 0.8
                ? { stateId: 1 }
                : roll < 0.87
                  ? { stateId: 2, collisionShapes: SLAB }
                  : roll < 0.94
                    ? { stateId: 3, collisionShapes: CARPET }
                    : { stateId: 4, collisionShapes: FENCE };
          if (x === 0 && z === 0 && (y === 63 || y === 64)) world.load({ x, y, z }, { stateId: 0 });
          else world.load({ x, y, z }, block);
        }
    const blockAt = (x: number, y: number, z: number) => world.blockAt(x, y, z);
    const sight = stanceSight(blockAt, STANCE);
    const rays = worldViewRaycaster((x, y, z) => obstaclesOf(blockAt(x, y, z)));
    for (let x = -5; x <= 5; x += 1)
      for (let y = 59; y <= 68; y += 1)
        for (let z = -5; z <= 5; z += 1) {
          const target = blockAt(x, y, z);
          if (target.kind !== "loaded" || target.traits.empty) continue;
          const dig = {
            position: { x, y, z },
            stateId: target.stateId,
            toolType: null,
            expectedTicks: 1,
            penalty: 0,
            brings: [],
          };
          const byRay =
            Math.hypot(x + 0.5 - STANCE.x, y + 0.5 - (STANCE.y + 1.65), z + 0.5 - STANCE.z) <= DIG_REACH &&
            visibleBlockAim(rays, eye, { x, y, z }, DIG_REACH, obstaclesOf(target) ?? []) !== null;
          assert.equal(sight.canSee(dig, []), byRay, `round ${round} target ${x},${y},${z}`);
          compared += 1;
        }
  }
  assert.ok(compared > 10_000);
});
