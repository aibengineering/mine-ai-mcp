import { HORIZONTAL_TICKS_PER_BLOCK, exactBlockGoal } from "../goals/index.js";
import { IncrementalSearch } from "../search/search.js";
import { MemoryWorld } from "../world/memory-world.js";
import { blockKey } from "../world/world.js";
import { type GeneratedMovement, type GenerationContext, createMovementCatalogue } from "./catalogue.js";
import { createMovementPolicy } from "./policy.js";
import type { StepField } from "../step-field.js";
import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, flatWorld, observation, planningStart } from "../../test-support/navigation.js";

type Cell = { x: number; y: number; z: number };

interface GenerateOptions {
  readonly scaffolds?: number;
  readonly policy?: Parameters<typeof createMovementPolicy>[0];
  readonly player?: GenerationContext["player"];
  readonly onGround?: boolean;
  readonly protectedFeet?: GenerationContext["protectedFeet"];
  readonly stepField?: StepField | null;
}

/** Everything the catalogue offers from `feet`, under the default policy unless the test says otherwise. */
function generateFrom(world: MemoryWorld, feet: Cell, options: GenerateOptions = {}): GeneratedMovement[] {
  return createMovementCatalogue()
    .generate(
      planningStart(feet, options.scaffolds ?? 0),
      {
        world,
        policy: createMovementPolicy(options.policy),
        player: options.player ?? WELL_FED,
        protectedFeet: options.protectedFeet,
        stepField: options.stepField ?? null,
      },
      { submergedAtEyes: false, onGround: options.onGround ?? true, aquaAffinity: false, effects: {} },
    )
    .toArray();
}

const ORIGIN: Cell = { x: 0, y: 63, z: 0 };
const to = (x: number, y: number, z: number) => (movement: GeneratedMovement) =>
  movement.step.to.x === x && movement.step.to.y === y && movement.step.to.z === z;
const breaksAt = (movement: GeneratedMovement, x: number, y: number) =>
  movement.step.operations.some(
    (operation) => operation.kind === "break" && operation.position.x === x && operation.position.y === y,
  );

const SOLID = { stateId: 1 } as const;
const AIR = { stateId: 0 } as const;

test("transition hazards can refuse a jump without excluding level walking or changing other routes", () => {
  const world = flat([{ x: 1, y: 63, z: 0 }, SOLID]);
  const baseline = generateFrom(world, ORIGIN);
  assert.ok(baseline.some(m => m.step.kind === "step_up"));
  const movements = generateFrom(world, ORIGIN, { policy: {
    allowSprinting: false,
    decideMovement: (kind, from, destination) => {
      assert.deepEqual(from, ORIGIN);
      return kind === "step_up" && destination.y > from.y
        ? { kind: "prohibited", reason: "overhead hazard" }
        : { kind: "allowed" };
    },
  } });
  assert.ok(movements.some(m => m.step.kind === "walk"));
  assert.equal(movements.some(m => m.step.kind === "step_up"), false);
});

test("walking and downward excavation reject suspended gravel but retain supported gravel", () => {
  const world = flatWorld();
  const gravel = { stateId: 124, traits: { falling: true } };
  world.load({ x: 1, y: 62, z: 0 }, gravel);
  world.load({ x: 1, y: 61, z: 0 }, AIR);
  assert.equal(generateFrom(world, ORIGIN).some(to(1, 63, 0)), false);
  world.load({ x: 1, y: 61, z: 0 }, SOLID);
  assert.equal(generateFrom(world, ORIGIN).some(to(1, 63, 0)), true);

  world.load({ x: 0, y: 61, z: 0 }, gravel);
  world.load({ x: 0, y: 60, z: 0 }, AIR);
  assert.equal(
    generateFrom(world, ORIGIN).some((m) => m.step.kind === "downward"),
    false,
  );
  world.load({ x: 0, y: 60, z: 0 }, SOLID);
  assert.equal(
    generateFrom(world, ORIGIN).some((m) => m.step.kind === "downward"),
    true,
  );
});
const water = (liquidSource: boolean) => ({
  stateId: 10,
  collisionShapes: [],
  traits: { empty: true, liquid: "water" as const, liquidSource, safeToBreak: false },
});
const LAVA = { stateId: 10, collisionShapes: [], traits: { empty: true, liquid: "lava" as const, safeToBreak: false } };
/** A carpet: full-width collision one sixteenth of a block tall. */
const CARPET = { stateId: 9, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.0625, maxZ: 1 }] };
const FENCE = { stateId: 2, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1.5, maxZ: 1 }] };

/** The flat world with the named cells changed. */
function flat(...edits: Array<[Cell, Parameters<MemoryWorld["load"]>[1]]>): MemoryWorld {
  const world = flatWorld();
  for (const [cell, block] of edits) world.load(cell, block);
  return world;
}

/** A slab of rock from y 62 down, open from y 63 to 66, with the columns `gap` accepts cut out of the floor. */
function runway(
  xRange: [number, number],
  gap: (x: number) => boolean,
  zRange: [number, number] = [-2, 2],
): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = xRange[0]; x <= xRange[1]; x += 1)
    for (let z = zRange[0]; z <= zRange[1]; z += 1) {
      world.load({ x, y: 62, z }, gap(x) ? AIR : SOLID);
      for (let y = 63; y <= 66; y += 1) world.load({ x, y, z }, AIR);
    }
  return world;
}

// ── What is offered, by shape ────────────────────────────────────────────────

/**
 * One row per shape: the movements the catalogue must offer from the bot's
 * cell and the ones it must withhold, as `kind@x,y,z` with `*` for any. Each
 * row is a bug that was observed once; the note says which.
 */
interface OfferRow {
  readonly shape: string;
  readonly world: () => MemoryWorld;
  readonly feet?: Cell;
  readonly options?: GenerateOptions;
  readonly has?: readonly string[];
  readonly lacks?: readonly string[];
}

function offers(movement: GeneratedMovement, pattern: string): boolean {
  const [kind, cell] = pattern.split("@") as [string, string];
  const [x, y, z] = cell.split(",");
  const matches = (want: string | undefined, actual: number | string) => want === "*" || String(actual) === want;
  return (
    matches(kind, movement.step.kind) &&
    matches(x, movement.step.to.x) &&
    matches(y, movement.step.to.y) &&
    matches(z, movement.step.to.z)
  );
}

const parkourRunway = (span: number) => runway([-6, 12], (x) => x >= 1 && x <= span);
/** A gap whose takeoff block carries the given parkour trait. */
function takeoff(landingX: number, trait: "normal" | "short" | "prohibited"): MemoryWorld {
  const world = runway([-2, landingX + 2], (x) => x > 0 && x < landingX, [-1, 1]);
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 1, traits: { parkourTakeoff: trait } });
  return world;
}
/** A one-block-wide shelf at y 62 with a three-block drop east of x 0, optionally with sand hanging over the landing. */
function cliff(falling: boolean): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -2; x <= 3; x += 1)
    for (let z = -2; z <= 2; z += 1) {
      world.load({ x, y: 62, z }, x <= 0 ? SOLID : AIR);
      world.load({ x, y: 59, z }, x >= 1 ? SOLID : AIR);
      for (const y of [60, 61, 63, 64, 65]) world.load({ x, y, z }, AIR);
    }
  if (falling) world.load({ x: 1, y: 62, z: 0 }, { stateId: 12, traits: { falling: true } });
  return world;
}
/** Solid rock at y 62 and 63 with the bot's own cell open; the east cell holds lava beside the route when asked. */
function lavaShelf(lavaBeside: boolean): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -3; x <= 3; x += 1)
    for (let z = -3; z <= 3; z += 1) {
      world.load({ x, y: 62, z }, SOLID);
      world.load({ x, y: 63, z }, SOLID);
      for (let y = 64; y <= 66; y += 1) world.load({ x, y, z }, AIR);
    }
  world.load({ x: 1, y: 63, z: 0 }, AIR);
  if (lavaBeside) world.load({ x: 2, y: 63, z: 1 }, { stateId: 90, traits: { empty: false, liquid: "lava" } });
  return world;
}
/** A one-block current across the east cell, deepened, or submerged to the given height. */
function ford(liquidSource: boolean, ...more: Array<[Cell, Parameters<MemoryWorld["load"]>[1]]>): MemoryWorld {
  return flat([{ x: 1, y: 63, z: 0 }, water(liquidSource)], ...more);
}

const OFFERS: readonly OfferRow[] = [
  {
    shape: "a floor whose corner the bot stands on",
    world: () => {
      const world = new MemoryWorld();
      for (let x = -1; x <= 2; x += 1)
        for (let z = -1; z <= 2; z += 1) {
          world.load({ x, y: 61, z }, SOLID);
          for (let y = 62; y <= 65; y += 1) world.load({ x, y, z }, AIR);
        }
      return world;
    },
    lacks: ["drop@1,*,1"],
  },
  { shape: "lava in the next cell", world: () => flat([{ x: 1, y: 63, z: 0 }, LAVA]), lacks: ["*@1,*,0"] },
  {
    shape: "a passage that would open beneath lava",
    world: () => flat([{ x: 1, y: 63, z: 0 }, SOLID], [{ x: 1, y: 64, z: 0 }, SOLID], [{ x: 1, y: 65, z: 0 }, LAVA]),
    lacks: ["*@1,63,0"],
  },
  {
    shape: "rock beneath, with direct downward excavation disabled",
    world: () => flat([{ x: 0, y: 61, z: 0 }, SOLID], [{ x: 1, y: 61, z: 0 }, SOLID]),
    options: { policy: { allowDownward: false } },
    has: ["drop@*,*,*"],
    lacks: ["downward@*,*,*"],
  },
  {
    shape: "a tread the route already stood on",
    world: () => flat([{ x: 1, y: 61, z: 0 }, SOLID], [{ x: 1, y: 64, z: 0 }, SOLID]),
    options: { protectedFeet: new Set([blockKey({ x: 1, y: 63, z: 0 })]) },
    lacks: ["*@1,62,0"],
  },
  {
    shape: "no support under the takeoff",
    world: () => flat([{ x: 0, y: 62, z: 0 }, AIR]),
    lacks: ["jump@*,*,*", "sprint_jump@*,*,*"],
  },
  { shape: "flat ground with open sky", world: () => flat([{ x: 1, y: 66, z: 0 }, AIR]), lacks: ["jump@*,*,*"] },
  {
    shape: "a one-block hole east",
    world: () => flat([{ x: 1, y: 66, z: 0 }, AIR], [{ x: 1, y: 62, z: 0 }, AIR]),
    has: ["jump@*,*,*"],
  },
  {
    shape: "a gap two cells away, with runway before it",
    world: () => flat([{ x: 2, y: 62, z: 0 }, AIR]),
    lacks: ["jump@*,*,*", "sprint_jump@*,*,*", "parkour@*,*,*"],
  },
  { shape: "a three-block gap", world: () => parkourRunway(3), has: ["parkour@*,*,*"] },
  {
    shape: "a three-block gap with parkour switched off",
    world: () => parkourRunway(3),
    options: { policy: { allowParkour: false } },
    lacks: ["jump@*,*,*", "sprint_jump@*,*,*", "parkour@*,*,*"],
  },
  { shape: "a block on the diagonal", world: () => flat([{ x: 1, y: 63, z: 1 }, SOLID]), has: ["*@1,64,1"] },
  {
    shape: "a block on the diagonal with diagonal ascent switched off",
    world: () => flat([{ x: 1, y: 63, z: 1 }, SOLID]),
    options: { policy: { allowDiagonalAscend: false } },
    lacks: ["*@1,64,1"],
  },
  {
    shape: "a block on the diagonal under an obstructed corner",
    world: () => flat([{ x: 1, y: 63, z: 1 }, SOLID], [{ x: 1, y: 65, z: 0 }, SOLID]),
    lacks: ["*@1,64,1"],
  },
  {
    shape: "a sprint whose look-ahead cell is prohibited",
    world: () => flatWorld(),
    options: {
      policy: {
        decideStep: (x: number) =>
          x === 2 ? { kind: "prohibited" as const, reason: "unsafe sprint look-ahead" } : { kind: "allowed" as const },
      },
    },
    has: ["walk@1,63,0"],
    lacks: ["sprint@1,63,0"],
  },
  { shape: "a two-block gap from a short takeoff", world: () => takeoff(2, "short"), has: ["jump@*,*,*"] },
  { shape: "a three-block gap from a short takeoff", world: () => takeoff(3, "short"), lacks: ["*@3,*,*", "*@4,*,*"] },
  {
    shape: "a two-block gap from a prohibited takeoff",
    world: () => takeoff(2, "prohibited"),
    lacks: ["jump@*,*,*", "sprint_jump@*,*,*", "parkour@*,*,*"],
  },
  {
    shape: "standing in water with scaffold to spare",
    world: () =>
      flat([
        { x: 0, y: 63, z: 0 },
        { ...water(true), traits: { empty: true, liquid: "water", liquidSource: true } },
      ]),
    options: { scaffolds: 4, policy: { allowPlacing: true, scaffold: { stateId: 1, itemType: 1 } } },
    lacks: ["pillar@*,*,*"],
  },
  {
    shape: "a short fall into a supported water source",
    world: () => flat([{ x: 1, y: 61, z: 0 }, SOLID], [{ x: 1, y: 62, z: 0 }, water(true)]),
    has: ["drop@1,*,*"],
  },
  {
    shape: "a short fall into supported flowing water",
    world: () => flat([{ x: 1, y: 61, z: 0 }, SOLID], [{ x: 1, y: 62, z: 0 }, water(false)]),
    has: ["drop@1,*,*"],
  },
  {
    shape: "a rock cell with nothing beside it",
    world: () => lavaShelf(false),
    feet: { x: 1, y: 63, z: 0 },
    has: ["*@2,63,*"],
  },
  {
    shape: "a rock cell laterally retaining lava",
    world: () => lavaShelf(true),
    feet: { x: 1, y: 63, z: 0 },
    lacks: ["*@2,63,*"],
  },
  {
    shape: "a mined hole under flowing water",
    world: () =>
      flat(
        [{ x: 1, y: 61, z: 0 }, SOLID],
        [{ x: 1, y: 62, z: 0 }, water(false)],
        [{ x: 1, y: 63, z: 0 }, water(false)],
      ),
    has: ["drop@1,62,0"],
  },
  { shape: "flat ground, well fed", world: () => flatWorld(), has: ["sprint@*,*,*"] },
  // Minecraft refuses to sprint at or below six food. Offering the edge anyway
  // prices walking at sprint speed and makes a three-block sprint_jump a fall.
  {
    shape: "flat ground, hungry",
    world: () => flatWorld(),
    options: { player: { food: 6, effects: {}, aquaAffinity: false } },
    has: ["walk@*,*,*"],
    lacks: ["sprint@*,*,*"],
  },
  { shape: "a three-block drop off a shelf", world: () => cliff(false), has: ["drop@1,*,*"] },
  // Sand over the landing falls in behind the bot and buries the cell the
  // route just claimed, failing the next step's preconditions.
  { shape: "a three-block drop under a falling column", world: () => cliff(true), lacks: ["drop@1,*,*"] },
  { shape: "a full-height block east", world: () => flat([{ x: 1, y: 63, z: 0 }, SOLID]), has: ["step_up@1,*,*"] },
  // A fence is a full-collision block one and a half blocks tall. Judged only
  // by "does it have collision", the planner offers a step onto its top and the
  // bot jumps at the fence for as long as its patience lasts. Baritone keeps
  // fences, walls, and gates out of `canWalkOn` for the same reason.
  { shape: "a fence east", world: () => flat([{ x: 1, y: 63, z: 0 }, FENCE]), lacks: ["step_up@1,*,*"] },
  {
    shape: "a carpet east",
    world: () => flat([{ x: 1, y: 63, z: 0 }, CARPET]),
    has: ["*@1,63,0"],
    lacks: ["step_up@1,64,*"],
  },
  {
    shape: "a two-deep hole full of water",
    world: () => flat([{ x: 0, y: 63, z: 0 }, water(false)], [{ x: 0, y: 64, z: 0 }, water(false)]),
    has: ["swim@0,64,0"],
  },
  {
    shape: "a three-deep hole full of water",
    world: () =>
      flat(
        [{ x: 0, y: 63, z: 0 }, water(false)],
        [{ x: 0, y: 64, z: 0 }, water(false)],
        [{ x: 0, y: 65, z: 0 }, water(false)],
      ),
    lacks: ["swim@0,64,0"],
  },
  { shape: "a shallow water source across the way", world: () => ford(true), has: ["*@1,63,0"] },
  { shape: "a shallow current across the way", world: () => ford(false), has: ["*@1,63,0"] },
  {
    shape: "a current with no floor under it",
    world: () => ford(false, [{ x: 1, y: 62, z: 0 }, AIR]),
    lacks: ["*@1,63,0"],
  },
  {
    shape: "a current two blocks deep with air above",
    world: () => ford(false, [{ x: 1, y: 64, z: 0 }, water(false)]),
    has: ["*@1,63,0"],
  },
  {
    shape: "a current three blocks deep",
    world: () => ford(false, [{ x: 1, y: 64, z: 0 }, water(false)], [{ x: 1, y: 65, z: 0 }, water(false)]),
    lacks: ["*@1,63,0"],
  },
  // Source water must obey the same air boundary; raw passability used to
  // admit this fully submerged journey while rejecting an identical current.
  {
    shape: "a source three blocks deep",
    world: () => ford(true, [{ x: 1, y: 64, z: 0 }, water(true)], [{ x: 1, y: 65, z: 0 }, water(true)]),
    lacks: ["*@1,63,0"],
  },
  {
    shape: "a vine under headroom that cannot be broken",
    world: () => vineShaft({ stateId: 1, traits: { safeToBreak: false } }),
    lacks: ["climb@0,64,0"],
  },
  // Whatever the price, the step is still offered. A prohibition would make a
  // doorway with a zombie in it unreachable; a price lets the search decide.
  {
    shape: "flat ground with a ruinously priced cell east",
    world: () => flatWorld(),
    options: { stepField: fieldAt({ x: 1, z: 0 }, 10_000) },
    has: ["*@1,*,0"],
  },
];

test("the catalogue offers and withholds movements by the shape of the ground", () => {
  for (const row of OFFERS) {
    const movements = generateFrom(row.world(), row.feet ?? ORIGIN, row.options);
    const offered = [
      ...new Set(
        movements.map(
          (movement) => `${movement.step.kind}@${movement.step.to.x},${movement.step.to.y},${movement.step.to.z}`,
        ),
      ),
    ].sort();
    for (const pattern of row.has ?? [])
      assert.ok(
        movements.some((movement) => offers(movement, pattern)),
        `${row.shape}: expected ${pattern} among ${offered.join(" ")}`,
      );
    for (const pattern of row.lacks ?? [])
      assert.equal(
        movements.some((movement) => offers(movement, pattern)),
        false,
        `${row.shape}: must not offer ${pattern}, offered ${offered.join(" ")}`,
      );
  }
});

// ── The shape of one movement ────────────────────────────────────────────────

test("a descent retains its landing floor as an execution precondition", () => {
  const world = flat([{ x: 0, y: 63, z: 0 }, SOLID], [{ x: 1, y: 64, z: 0 }, SOLID]);
  const descent = generateFrom(world, { x: 0, y: 64, z: 0 }).find(
    ({ step }) => step.kind === "drop" && step.to.x === 1 && step.to.y === 63 && step.to.z === 0,
  );
  assert.ok(descent);
  const floor = descent.step.preconditions.find(
    ({ position }) => position.x === 1 && position.y === 62 && position.z === 0,
  );
  assert.ok(floor);
  assert.ok(floor.expected.matches(world.blockAt(1, 62, 0)));
  world.load({ x: 1, y: 62, z: 0 }, AIR);
  assert.equal(floor.expected.matches(world.blockAt(1, 62, 0)), false);
});

test("a short stalagmite cannot be a step-up tread or a level landing", () => {
  for (const height of [0.6875, 0.875]) {
    const tip = {
      stateId: 2,
      collisionShapes: [{ minX: 0.25, minY: 0, minZ: 0.25, maxX: 0.75, maxY: height, maxZ: 0.75 }],
    };
    const world = flat([{ x: 1, y: 63, z: 0 }, tip], [{ x: 1, y: 62, z: 1 }, tip]);
    const movements = generateFrom(world, ORIGIN);
    assert.equal(
      movements.some(({ step }) => step.kind === "step_up" && step.to.x === 1 && step.to.z === 0),
      false,
    );
    assert.equal(movements.some(to(1, 63, 1)), false);
  }
});

test("the movement catalogue can excavate one supported stair downward", () => {
  const world = flat([{ x: 1, y: 61, z: 0 }, SOLID], [{ x: 1, y: 64, z: 0 }, SOLID]);
  const descending = generateFrom(world, ORIGIN).find(to(1, 62, 0));
  assert.equal(descending?.step.kind, "drop");
  assert.ok(descending && breaksAt(descending, 1, 64));
});

test("one passage through a two-block door activates the shared door once", () => {
  const doorTraits = { openable: true, open: false, activationGroup: "oak_door" } as const;
  const world = flat(
    [
      { x: 1, y: 63, z: 0 },
      { stateId: 10, traits: doorTraits },
    ],
    [
      { x: 1, y: 64, z: 0 },
      { stateId: 11, traits: { ...doorTraits, upperHalf: true } },
    ],
  );
  const movement = generateFrom(world, ORIGIN, { policy: { allowDoors: true } }).find(to(1, 63, 0));

  assert.ok(movement);
  assert.equal(movement.step.operations.filter((operation) => operation.kind === "activate").length, 1);
  assert.equal(movement.step.effects.filter((effect) => effect.kind === "activate").length, 2);
});

test("the movement catalogue does not invent vertical swim edges", () => {
  const world = flat(
    [{ x: 0, y: 63, z: 0 }, water(false)],
    [{ x: 0, y: 64, z: 0 }, water(false)],
    [{ x: 0, y: 62, z: 0 }, water(false)],
  );
  assert.equal(
    generateFrom(world, ORIGIN, { onGround: false }).some(({ step }) => step.kind === "swim" && step.to.y !== 63),
    false,
  );
});

test("direct downward excavation is enabled by default and breaks only the block beneath the bot", () => {
  const world = flat([{ x: 0, y: 61, z: 0 }, SOLID], [{ x: 1, y: 61, z: 0 }, SOLID]);
  const downward = generateFrom(world, ORIGIN).find((movement) => movement.step.kind === "downward");

  assert.ok(downward);
  assert.deepEqual(downward.step.to, { x: 0, y: 62, z: 0 });
  assert.deepEqual(
    downward.step.operations.map((operation) => operation.kind),
    ["break", "move"],
  );
  assert.deepEqual(downward.step.effects, [{ kind: "break", position: { x: 0, y: 62, z: 0 }, stateId: 0 }]);
});

test("A star chooses direct downward excavation for an aligned deep goal", () => {
  const world = new MemoryWorld();
  for (let x = -3; x <= 3; x += 1)
    for (let z = -3; z <= 3; z += 1) {
      for (let y = 60; y <= 63; y += 1) world.load({ x, y, z }, SOLID);
      for (let y = 64; y <= 66; y += 1) world.load({ x, y, z }, AIR);
    }
  const goal = exactBlockGoal({ x: 0, y: 61, z: 0 }).resolve(observation(0, 64, 0));
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") return;
  const search = new IncrementalSearch({
    id: "direct-downward",
    start: planningStart({ x: 0, y: 64, z: 0 }),
    goal,
    now: () => 0,
    context: { world, policy: createMovementPolicy(), player: WELL_FED, catalogue: createMovementCatalogue() },
  });
  const result = search.advance({ maximumExpansions: 1_000 });

  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.deepEqual(
    result.plan.steps.map((step) => step.kind),
    ["downward", "downward", "downward"],
  );
  assert.deepEqual(
    result.plan.steps.map((step) => step.to),
    [
      { x: 0, y: 63, z: 0 },
      { x: 0, y: 62, z: 0 },
      { x: 0, y: 61, z: 0 },
    ],
  );
});

test("a step up clears the takeoff headroom needed to jump", () => {
  const world = flat([{ x: 1, y: 63, z: 0 }, SOLID], [{ x: 0, y: 65, z: 0 }, SOLID], [{ x: 0, y: 66, z: 0 }, AIR]);
  const ascending = generateFrom(world, ORIGIN, {
    policy: {
      evaluateBreak: (_block, position) => ({
        decision:
          position.x === 1 && position.y === 63
            ? { kind: "prohibited", reason: "use the block as the step" }
            : { kind: "allowed" },
        tool: { itemType: null, expectedTicks: 20 },
      }),
    },
  }).find(to(1, 64, 0));
  assert.equal(ascending?.step.kind, "step_up");
  assert.ok(ascending && breaksAt(ascending, 0, 65));
});

test("an exposed solid tread is stepped onto instead of dug through", () => {
  const towardTread = generateFrom(flat([{ x: 1, y: 63, z: 0 }, SOLID]), ORIGIN).find(
    (movement) => movement.step.to.x === 1 && movement.step.to.z === 0,
  );
  assert.equal(towardTread?.step.kind, "step_up");
  assert.equal(towardTread?.step.to.y, 64);
  assert.ok(towardTread && !breaksAt(towardTread, 1, 63));
});

test("a missing adjacent stair tread can be placed and ascended in one movement", () => {
  const repair = generateFrom(flatWorld(), ORIGIN, {
    scaffolds: 1,
    policy: { scaffold: { itemType: 1, stateId: 1 } },
  }).find((movement) => movement.step.kind === "step_up" && movement.step.to.x === 1 && movement.step.to.y === 64);

  assert.ok(repair);
  assert.deepEqual(
    repair.step.operations.map((operation) => operation.kind),
    ["place", "move"],
  );
  assert.deepEqual(repair.step.effects, [{ kind: "place", position: { x: 1, y: 63, z: 0 }, stateId: 1 }]);
  assert.equal(repair.state.node.remainingScaffolds, 0);
});

test("an axis block is placed in the state its support face produces", () => {
  const bridge = generateFrom(flat([{ x: 1, y: 62, z: 0 }, AIR]), ORIGIN, {
    scaffolds: 1,
    policy: { scaffold: { itemType: 1, stateId: 12, stateIdByAxis: { x: 11, y: 12, z: 13 } } },
  }).find((movement) => movement.step.kind === "walk" && movement.step.to.x === 1 && movement.step.to.y === 63);
  assert.ok(bridge);
  const placement = bridge.step.operations.find((operation) => operation.kind === "place");
  assert.ok(placement && placement.kind === "place");
  // Set against the block the bot stands on, so the server aligns it along x.
  assert.deepEqual(placement.placement.support, { x: 0, y: 62, z: 0 });
  assert.equal(placement.placement.stateId, 11);
  assert.deepEqual(bridge.step.effects, [{ kind: "place", position: { x: 1, y: 62, z: 0 }, stateId: 11 }]);
});

test("a pillar step clears the destination feet cell before placing beneath it", () => {
  const pillar = generateFrom(flat([{ x: 0, y: 64, z: 0 }, SOLID]), ORIGIN, {
    scaffolds: 1,
    policy: { allowPlacing: true, scaffold: { itemType: 1, stateId: 1 } },
  }).find(to(0, 64, 0));
  assert.equal(pillar?.step.kind, "pillar");
  assert.deepEqual(
    pillar?.step.operations.map((operation) => operation.kind),
    ["break", "place", "move"],
  );
});

test("a diagonal is charged for the distance it actually covers", () => {
  const moves = generateFrom(flatWorld(), ORIGIN);
  const cardinal = moves.find((move) => move.step.to.x === 1 && move.step.to.z === 0);
  const diagonal = moves.find((move) => move.step.to.x === 1 && move.step.to.z === 1);
  assert.ok(cardinal && diagonal);
  // Equal cost per block is the property that matters: an unscaled diagonal was
  // cheaper per block than a straight sprint and biased routes into zigzags.
  assert.equal(cardinal.step.cost.total, 4);
  assert.ok(Math.abs(diagonal.step.cost.total - 4 * Math.SQRT2) < 1e-9);
  assert.equal(diagonal.step.kind, "sprint");
});

test("no level movement is cheaper per block than the horizontal estimate", () => {
  // Horizontal travel is charged at the cheapest movement that can deliver it,
  // a four-tick sprint, so the estimate never over-promises on level ground.
  //
  // The whole estimate is still not admissible, and is not claimed to be: it
  // sums its axis components the way Baritone's `GoalBlock` sums `GoalXZ` and
  // `GoalYLevel`, while one movement can cover both at once — a drop travels a
  // block sideways as it falls three. This asserts the horizontal term alone,
  // which is the part that is a genuine floor.
  const world = flatWorld();
  for (let x = -5; x <= 5; x += 1) world.load({ x, y: 62, z: 3 }, AIR);
  for (const feet of [ORIGIN, { x: 0, y: 63, z: 2 }])
    for (const move of generateFrom(world, feet)) {
      const { from, to: end } = move.step;
      if (end.y !== from.y) continue;
      const length = Math.hypot(end.x - from.x, end.z - from.z);
      if (length === 0) continue;
      assert.ok(
        move.step.cost.total / length >= HORIZONTAL_TICKS_PER_BLOCK - 1e-9,
        `${move.step.kind} costs ${move.step.cost.total / length} per block, below the ${HORIZONTAL_TICKS_PER_BLOCK} estimate`,
      );
    }
});

test("parkour clears a four-block gap instead of duplicating jump", () => {
  const crossing = generateFrom(parkourRunway(3), ORIGIN, { policy: { allowParkour: true } }).filter(
    (move) => move.step.to.x > 0 && move.step.to.z === 0,
  );
  assert.deepEqual(
    crossing.map((move) => `${move.step.kind}->${move.step.to.x}`),
    ["parkour->4"],
  );
  assert.equal(new Set(crossing.map((move) => move.step.to.x)).size, crossing.length);
});

test("a gap jump rejects a ceiling in the fourth cell above the takeoff feet", () => {
  for (const distance of [2, 3, 4]) {
    const world = runway([-2, distance + 2], (x) => x > 0 && x < distance, [0, 0]);
    const crosses = ({ step }: GeneratedMovement) => step.to.x === distance && step.to.z === 0;
    assert.ok(generateFrom(world, ORIGIN).some(crosses), `open span ${distance}`);
    world.load({ x: distance - 1, y: 66, z: 0 }, SOLID);
    assert.equal(generateFrom(world, ORIGIN).some(crosses), false, `obstructed span ${distance}`);
  }
});

test("parkour is enabled by default", () => {
  assert.equal(createMovementPolicy().allowParkour, true);
});

test("a block that answers a right-click is not used as a placement support", () => {
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x += 1)
    for (let z = -2; z <= 2; z += 1) {
      world.load({ x, y: 62, z }, x === 0 && z === 0 ? SOLID : AIR);
      for (let y = 63; y <= 65; y += 1) world.load({ x, y, z }, AIR);
    }
  const options: GenerateOptions = {
    scaffolds: 8,
    policy: { scaffold: { stateId: 1, itemType: 1 }, allowPlacing: true },
  };
  const places = (moves: GeneratedMovement[]) =>
    moves.some((move) => move.step.operations.some((operation) => operation.kind === "place"));
  assert.ok(places(generateFrom(world, ORIGIN, options)));
  // A chest face opens the chest instead of accepting the block, so the
  // placement never lands and the route replans onto the same support.
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 54, traits: { interactive: true } });
  assert.equal(places(generateFrom(world, ORIGIN, options)), false);
});

test("a bot just below the ocean surface can rise without a floor beneath it", () => {
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++) for (let y = 60; y <= 67; y++) world.load({ x, y, z }, y <= 64 ? water(true) : AIR);
  assert.deepEqual(
    generateFrom(world, ORIGIN).map(({ step }) => ({ kind: step.kind, to: step.to })),
    [{ kind: "swim", to: { x: 0, y: 64, z: 0 } }],
    "The escape is upward to air, not a submerged crossing.",
  );
  assert.equal(generateFrom(world, { x: 0, y: 64, z: 0 }).filter(({ step }) => step.kind === "swim").length, 8);
  world.load({ x: 0, y: 65, z: 0 }, SOLID);
  assert.equal(generateFrom(world, ORIGIN).length, 0, "A solid roof must still prevent surfacing.");
});

/**
 * A vine the bot is standing in, climbing upward, with the cell its head would
 * enter carved to order.
 *
 * Observed live on 2026-09-04: the bot had earlier placed a cobblestone in the
 * middle of a vine shaft it later wanted to climb. Pathfinder offered the climb
 * anyway, the bot jammed against the block, and nothing ever broke it, because
 * the climb had never looked at the cell above its destination at all.
 */
function vineShaft(head: { stateId: number; traits?: Record<string, unknown> } | null): MemoryWorld {
  const world = flatWorld();
  // The flat world stops at y 65; a dig reads the column above its target, so
  // the shaft needs open air over it to be judged at all.
  for (let x = -1; x <= 1; x += 1)
    for (let z = -1; z <= 1; z += 1) for (const y of [66, 67]) world.load({ x, y, z }, AIR);
  const vine = { stateId: 7, collisionShapes: [], traits: { empty: true, climbable: true } };
  world.load({ x: 0, y: 63, z: 0 }, vine);
  world.load({ x: 0, y: 64, z: 0 }, vine);
  if (head) world.load({ x: 0, y: 65, z: 0 }, head as never);
  return world;
}

/** The upward climb out of the bot's cell, if the catalogue offers one. */
function climbUpFrom(world: MemoryWorld) {
  return generateFrom(world, ORIGIN).find((movement) => movement.step.kind === "climb" && movement.step.to.y === 64);
}

test("a climb up a vine breaks only what blocks its headroom", () => {
  const open = climbUpFrom(vineShaft(null));
  assert.equal(open?.step.to.y, 64);
  assert.deepEqual(
    open?.step.operations.filter((operation) => operation.kind === "break"),
    [],
  );

  const blocked = climbUpFrom(vineShaft({ stateId: 1 }));
  assert.equal(blocked?.step.to.y, 64, "the climb is still offered when the blocking block can be broken");
  assert.deepEqual(
    blocked?.step.operations.flatMap((operation) => (operation.kind === "break" ? [operation.position] : [])),
    [{ x: 0, y: 65, z: 0 }],
  );
});

/**
 * A column is entered from above by walking over its top climbable and
 * stepping down into it. Requiring the bot to be inside already made every
 * ladder and vine a dead end from the top: on the vine-ladder-column fixture
 * the search dug through the stone beside a ladder rather than descend it.
 */
test("the cell over a vine is walkable and offers a climb down into the vine", () => {
  const world = vineShaft(null);
  world.load({ x: 1, y: 64, z: 0 }, SOLID);
  const fromLedge = generateFrom(world, { x: 1, y: 65, z: 0 });
  assert.ok(
    fromLedge.some(
      (movement) =>
        (movement.step.kind === "walk" || movement.step.kind === "sprint") &&
        movement.step.to.x === 0 &&
        movement.step.to.y === 65,
    ),
    "a vine beneath the next cell is support the body hangs in",
  );
  const fromTop = generateFrom(world, { x: 0, y: 65, z: 0 });
  assert.ok(
    fromTop.some((movement) => movement.step.kind === "climb" && movement.step.to.y === 64),
    "stepping down into the climbable is a climb",
  );
  assert.equal(
    fromTop.some((movement) => movement.step.kind === "climb" && movement.step.to.y === 66),
    false,
    "climbing up still needs the bot inside the climbable",
  );
});

const VINE = { stateId: 7, collisionShapes: [], traits: { empty: true, climbable: true } } as const;

/**
 * A climbable is support to hang in, never a pad to land on.
 *
 * It has no collision and clamps only the descent, so a body that arrives with
 * horizontal speed crosses the column's one block of width and leaves by the
 * far side still falling. Two live incidents on 2026-09-13 within two hours of
 * each other: bd95619b planned `69,94,76>73,94,76:parkour` onto a free-hanging
 * vine over a chasm, held forward and sprint through seven ticks of contact,
 * and fell nineteen blocks; 97c795ac sprinted off a ledge into a vine-supported
 * cell at -6,102,29, drifted a block sideways out of the column, and fell five.
 * A third, the same rule in the fall family, was caught by the
 * vine-ledge-entry fixture: a drop onto the top of a column settles at the
 * column's foot, not at the cell the route planned.
 *
 * Entering a column belongs to `climb`, from directly overhead at no
 * horizontal speed, and to a walking traverse from the side — which a ladder
 * shaft entered at mid-height depends on, so that one is downgraded rather
 * than refused.
 */
test("a column is never a landing: no jump onto it, no drop onto it, and a walked entry rather than a sprint", () => {
  // A four-block gap whose only landing is a free-hanging column.
  const chasm = runway([-6, 12], (x) => x >= 1);
  for (let y = 62; y <= 66; y += 1) chasm.load({ x: 4, y, z: 0 }, VINE);
  chasm.load({ x: 4, y: 67, z: 0 }, SOLID);
  assert.deepEqual(
    generateFrom(chasm, ORIGIN).filter(to(4, 63, 0)).map((movement) => movement.step.kind),
    [],
    "a gap jump cannot stop inside a column, whatever the span",
  );

  // The same column reached from the lip beside it: entry stays available.
  const lip = runway([-6, 12], (x) => x >= 1);
  for (let y = 58; y <= 66; y += 1) lip.load({ x: 1, y, z: 0 }, VINE);
  lip.load({ x: 1, y: 67, z: 0 }, SOLID);
  assert.deepEqual(
    generateFrom(lip, ORIGIN).filter(to(1, 63, 0)).map((movement) => movement.step.kind),
    ["walk"],
    "a lateral entry is kept for ladder shafts, at walking speed rather than sprinting",
  );

  // A drop whose landing is held up by the top of a column. The shaft below
  // the runway has to be loaded air for the fall family to judge it at all.
  const overColumn = runway([-6, 12], (x) => x >= 1);
  for (let x = 0; x <= 2; x += 1)
    for (let z = -2; z <= 2; z += 1) for (let y = 54; y <= 61; y += 1) overColumn.load({ x, y, z }, AIR);
  for (let y = 55; y <= 60; y += 1) overColumn.load({ x: 1, y, z: 0 }, VINE);
  assert.deepEqual(
    generateFrom(overColumn, ORIGIN).filter((movement) => movement.step.kind === "drop"),
    [],
    "a falling body slides to the column's foot instead of settling on its top",
  );
});

/**
 * Thin collision is walked over at floor level, which is why it counts as
 * passable. One cell up it is not the floor, it is chest height: a 1.8-block
 * body occupies feet+1.0 to feet+1.8, and a carpet resting on the carpet below
 * it sits exactly there.
 *
 * Observed live on 2026-09-04: a moss carpet stacked on another blocked the bot
 * outright, while the catalogue judged the cell passable on thinness alone and
 * routed into it with a clear lane standing beside it.
 */
test("a thin block is walked over underfoot and broken at head height", () => {
  const underfoot = generateFrom(flat([{ x: 1, y: 63, z: 0 }, CARPET]), ORIGIN).find(to(1, 63, 0));
  assert.ok(underfoot, "a step east is offered");
  assert.deepEqual(
    underfoot.step.operations.filter((operation) => operation.kind === "break"),
    [],
    "walking on to a carpet breaks nothing",
  );

  const stacked = generateFrom(flat([{ x: 1, y: 63, z: 0 }, CARPET], [{ x: 1, y: 64, z: 0 }, CARPET]), ORIGIN).find(
    to(1, 63, 0),
  );
  assert.ok(
    stacked && breaksAt(stacked, 1, 64),
    `stepped into a chest-height carpet without breaking it: ${JSON.stringify(stacked?.step.operations)}`,
  );
});

/** A field that prices one column and nothing else. */
function fieldAt(cell: { x: number; z: number }, cost: number): StepField {
  return {
    costAt: (x, _y, z) => (x === cell.x && z === cell.z ? cost : 0),
    fingerprint: `${cell.x},${cell.z}=${cost}`,
  };
}

test("excavated descent applies destination policy and field cost", () => {
  const world = flat([{ x: 1, y: 61, z: 0 }, SOLID], [{ x: 1, y: 64, z: 0 }, SOLID]);
  const plain = generateFrom(world, ORIGIN).find(to(1, 62, 0));
  const priced = generateFrom(world, ORIGIN, {
    stepField: { fingerprint: "destination", costAt: (_x, y) => (y === 62 ? 1000 : 0) },
  }).find(to(1, 62, 0));
  assert.ok(plain);
  assert.ok(priced);
  assert.equal(priced.cost, plain.cost + 1000);
  const prohibited = generateFrom(world, ORIGIN, {
    policy: {
      decideStep: (_x: number, y: number) =>
        y === 62 ? { kind: "prohibited", reason: "protected landing" } : { kind: "allowed" },
    },
  });
  assert.equal(prohibited.some(to(1, 62, 0)), false);
});

test("a supplied step field is charged on the cell it prices", () => {
  const world = flatWorld();
  const plain = generateFrom(world, ORIGIN).find(to(1, 63, 0));
  const priced = generateFrom(world, ORIGIN, { stepField: fieldAt({ x: 1, z: 0 }, 17) }).find(to(1, 63, 0));

  assert.equal(priced?.cost, (plain?.cost ?? 0) + 17);
  assert.equal(priced?.step.cost.hazardPenalty, (plain?.step.cost.hazardPenalty ?? 0) + 17);
  // The cell the bot is leaving is not the cell it is entering: a field on the
  // source would tax standing still and every step out of it equally.
  const north = generateFrom(world, ORIGIN, { stepField: fieldAt({ x: 1, z: 0 }, 17) }).find(
    (movement) => movement.step.to.z === 1 && movement.step.to.x === 0,
  );
  assert.equal(north?.step.cost.hazardPenalty, 0);
});
