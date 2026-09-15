import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { occupyGoal } from "../../index.js";
import { raycastThrough } from "../../../test-support/world.js";
import { DROP_PICKUP_TIMEOUT_MS } from "./mine-drops.js";
import { mine, type MineRequest } from "./mine-process.js";

const goalTestWorld = new GoalTestWorld();

/**
 * The planner asks a goal about the bot's own feet before it searches, so a
 * goal that is satisfied where the bot already stands ends the run without
 * moving. For a mining goal that is a spin: nothing is broken, the quantity is
 * never met, and the process asks again forever.
 */
function satisfiedAt(feet: Vec3, target: Vec3, levels: 2 | 3): boolean {
  const snapshot = occupyGoal(target, levels).resolve({ position: feet, entities: new Map() } as never);
  assert.equal(snapshot.kind, "active");
  if (snapshot.kind !== "active") throw new Error("unreachable");
  return snapshot.isSatisfied({ feet, remainingScaffolds: [], overlayId: "overlay:0" } as never, goalTestWorld);
}

test("occupying a target means standing in its cell", () => {
  assert.equal(satisfiedAt(new Vec3(5, 64, -2), new Vec3(5, 64, -2), 3), true);
});

test("a player standing below a target occupies it, because it is two blocks tall", () => {
  assert.equal(satisfiedAt(new Vec3(5, 63, -2), new Vec3(5, 64, -2), 3), true);
  assert.equal(satisfiedAt(new Vec3(5, 62, -2), new Vec3(5, 64, -2), 3), true);
});

test("two-level occupancy excludes the cell two below the target", () => {
  assert.equal(satisfiedAt(new Vec3(5, 63, -2), new Vec3(5, 64, -2), 2), true);
  assert.equal(satisfiedAt(new Vec3(5, 62, -2), new Vec3(5, 64, -2), 2), false);
});

test("a target in another column is never occupied", () => {
  assert.equal(satisfiedAt(new Vec3(0, 64, 0), new Vec3(5, 64, -2), 3), false);
});

/**
 * The consequence worth stating, because it is a trap rather than a bug: a
 * target in the bot's own column at head height is *already* occupied, so the
 * planner reports the goal reached without moving or breaking anything.
 * Baritone answers this in `MineProcess.onTick`, which breaks a known location
 * directly above or below the player itself rather than pathing to it.
 */
test("a target at head height is already occupied, so pathing to it does nothing", () => {
  assert.equal(satisfiedAt(new Vec3(5, 64, -2), new Vec3(5, 65, -2), 3), true);
  assert.equal(satisfiedAt(new Vec3(5, 66, -2), new Vec3(5, 66, -2), 3), true);
});

function fakeBot(options: {
  blocks?: Vec3[];
  solids?: Vec3[];
  lava?: Vec3[];
  carrying?: { name: string }[];
  drops?: Vec3[];
  feet?: Vec3;
  onGround?: boolean;
  isInWater?: boolean;
  onBlockRead?: () => void;
  onWaitForTicks?: () => void | Promise<void>;
}): Bot {
  const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
  const blocks = new Set((options.blocks ?? []).map(key));
  const solids = new Set((options.solids ?? []).map(key));
  const lava = new Set((options.lava ?? []).map(key));
  const obsidian = new Set<string>();
  const water = new Set<string>();
  const solid = (cell: Vec3) => blocks.has(key(cell)) || solids.has(key(cell)) || obsidian.has(key(cell));
  const entities = Object.fromEntries((options.drops ?? []).map((cell, index) => [index, fakeItemEntity(index, cell)]));
  const events = new EventEmitter();
  return {
    on: events.on.bind(events),
    off: events.off.bind(events),
    setControlState: () => {},
    entity: {
      position: options.feet ?? new Vec3(0, 64, 0),
      onGround: options.onGround ?? true,
      isInWater: options.isInWater ?? false,
      height: 1.8,
    },
    entities,
    registry: {
      blocksByName: {
        lava: { minStateId: 3, id: 11 },
        water: { minStateId: 4, id: 9 },
        obsidian: { minStateId: 5, id: 49 },
        cobblestone: { id: 14 },
      },
    },
    inventory: { items: () => options.carrying ?? [] },
    world: {
      getColumns: () => [
        {
          chunkX: 0,
          chunkZ: 0,
          column: {
            minY: 64,
            sections: [
              {
                solidBlockCount: blocks.size + lava.size + obsidian.size,
                data: {},
                palette: [
                  0,
                  ...(blocks.size === 0 ? [] : [1]),
                  ...(lava.size === 0 ? [] : [3]),
                  ...(obsidian.size === 0 ? [] : [5]),
                ],
                get: (cell: Vec3) => {
                  const at = `${cell.x},${cell.y + 64},${cell.z}`;
                  if (blocks.has(at)) return 1;
                  if (obsidian.has(at)) return 5;
                  return lava.has(at) ? 3 : 0;
                },
              },
            ],
          },
        },
      ],
      raycast: (origin: Vec3, direction: Vec3, distance: number) => raycastThrough(solid, origin, direction, distance),
    },
    waitForTicks: async () => {
      await options.onWaitForTicks?.();
      if (!options.onWaitForTicks) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    findBlocks: ({ matching }: { matching: number }) =>
      matching === 49
        ? [...obsidian].map((at) => new Vec3(...(at.split(",").map(Number) as [number, number, number])))
        : [],
    blockAt: (cell: Vec3) => {
      options.onBlockRead?.();
      const at = key(cell);
      const block = (name: string, stateId: number, boundingBox: "block" | "empty", diggable = true) => ({
        shapes: boundingBox === "block" ? [[0, 0, 0, 1, 1, 1]] : [],
        getProperties: () => ({}),
        name,
        position: cell,
        diggable,
        stateId,
        boundingBox,
      });
      if (blocks.has(at)) return block("stone", 1, "block");
      if (solids.has(at)) return block("dirt", 2, "block");
      if (obsidian.has(at)) return block("obsidian", 5, "block");
      if (lava.has(at)) return block("lava", 3, "empty", false);
      if (water.has(at)) return block("water", 4, "empty", false);
      return block("air", 0, "empty");
    },
    removeBlock: (cell: Vec3) => blocks.delete(key(cell)),
    addBlock: (cell: Vec3) => blocks.add(key(cell)),
    removeObsidian: (cell: Vec3) => obsidian.delete(key(cell)),
    addObsidian: (cell: Vec3) => obsidian.add(key(cell)),
    removeLava: (cell: Vec3) => lava.delete(key(cell)),
    addWater: (cell: Vec3) => water.add(key(cell)),
    removeWater: (cell: Vec3) => water.delete(key(cell)),
  } as unknown as Bot;
}

/** The world mutators a test uses to play the server's side of a cast. */
type FakeWorld = Bot & {
  addBlock(cell: Vec3): void;
  removeBlock(cell: Vec3): void;
  addObsidian(cell: Vec3): void;
  removeObsidian(cell: Vec3): void;
  removeLava(cell: Vec3): void;
  addWater(cell: Vec3): void;
  removeWater(cell: Vec3): void;
};

function fakeItemEntity(id: number, position: Vec3): Bot["entity"] {
  return { id, name: "item", position, getDroppedItem: () => ({ name: "stone" }) } as Bot["entity"];
}

function request(bot: Bot, overrides: Partial<MineRequest> = {}): MineRequest {
  return {
    matches: (block) => block.name === "stone",
    canMine: (block) =>
      block.diggable === false
        ? { kind: "prohibited", reason: `${block.name} cannot be broken at all` }
        : { kind: "mineable", routeMayBreak: true },
    matchingStateIds: new Set([1]),
    collects: () => true,
    isSatisfied: () => false,
    observedInventoryGain: () => 0,
    movements: {} as MineRequest["movements"],
    castSearchRadius: 64,
    explore: false,
    maximumBreaks: 4,
    route: async () => ({ status: "completed", elapsedMs: 0 }),
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "the fake bot places nothing" }),
    cast: null,
    ...overrides,
  };
}

test("a non-exploratory run with nothing matching in range stops", async () => {
  const bot = fakeBot({});
  const result = await mine(bot, request(bot));

  assert.equal(result.status, "no_targets");
  assert.deepEqual(result.broken, []);
});

test("nearby drops are recovered before another source is offered for mining", async () => {
  const cell = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [cell], drops: [cell] });
  let satisfied = false;
  let kinds: string[] = [];
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      onTargets: (targets) => {
        kinds = targets.map((target) => target.kind);
      },
      route: async () => {
        assert.deepEqual(kinds, ["drop"]);
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
});

test("an exploratory run keeps one branch point and rewards outward progress at its Y level", async () => {
  const bot = fakeBot({ feet: new Vec3(0.5, 64, 0.5) });
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      explore: true,
      isSatisfied: () => satisfied,
      route: async (options) => {
        const observation = { position: bot.entity.position, entities: new Map() } as never;
        const first = options.goal.resolve(observation);
        const second = options.goal.resolve(observation);
        assert.equal(first.kind, "active");
        assert.equal(second.kind, "active");
        if (first.kind !== "active" || second.kind !== "active") throw new Error("unreachable");
        assert.equal(first.revision, second.revision);

        const node = (x: number, y: number) =>
          ({ feet: { x, y, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }) as never;
        assert.equal(first.isSatisfied(node(0, 64), goalTestWorld), false);
        assert.ok(first.heuristic(node(6, 64)) < first.heuristic(node(0, 64)));
        assert.ok(first.heuristic(node(6, 65)) > first.heuristic(node(6, 64)));

        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

test("a calculation failure while exploring stops instead of reopening the same search", async () => {
  const bot = fakeBot({});
  let routes = 0;

  const result = await mine(
    bot,
    request(bot, {
      explore: true,
      route: async (options) => {
        routes += 1;
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 0,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(routes, 1);
  assert.equal(result.status, "stopped");
  assert.equal(
    result.reason,
    "no path found after 1 ms compute; visited 1 nodes, generated 1; closest node was 0,64,0",
  );
});

test("a newly observed ore target replaces the branch goal in the same route", async () => {
  const bot = fakeBot({});
  const target = new Vec3(5, 64, 0);
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      explore: true,
      isSatisfied: () => satisfied,
      route: async (options) => {
        const observation = { position: bot.entity.position, entities: new Map() } as never;
        const branch = options.goal.resolve(observation);
        assert.equal(branch.kind, "active");
        if (branch.kind !== "active") throw new Error("unreachable");
        assert.match(branch.revision, /^mine-branch:/);

        (bot as Bot & { addBlock(cell: Vec3): boolean }).addBlock(target);
        await new Promise((resolve) => setTimeout(resolve, 260));

        const ore = options.goal.resolve(observation);
        assert.equal(ore.kind, "active");
        if (ore.kind !== "active") throw new Error("unreachable");
        assert.doesNotMatch(ore.revision, /^mine-branch:/);
        assert.match(ore.revision, /5,64,0/);

        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

test("an anticipated drop follows Mineflayer's item entity before its metadata arrives", async () => {
  const target = new Vec3(5, 64, 0);
  const bot = fakeBot({ blocks: [target] });
  let satisfied = false;
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        (bot as Bot & { removeBlock(cell: Vec3): boolean }).removeBlock(target);
        const resolution = await options.onArrival?.({
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "continue");
        assert.equal(options.goal.resolve({ position: bot.entity.position } as never).kind, "active");
        setTimeout(() => {
          bot.entities[0] = {
            id: 0,
            name: "item",
            position: new Vec3(5, 63, 0),
            getDroppedItem: () => {
              throw new Error("metadata has not arrived");
            },
          } as never;
        }, 50);
        const afterFailure = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 1,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(afterFailure?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

test("an occupied drop arrival yields a server pickup interval before continuing", async () => {
  let ticks = 0;
  const bot = fakeBot({
    drops: [new Vec3(0, 64, 0)],
    feet: new Vec3(0, 64, 0),
    onWaitForTicks: () => {
      ticks += 1;
    },
  });
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const resolution = await options.onArrival?.({
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 1);
});

test("a vanished item stays pending until Mineflayer applies the inventory packet", async () => {
  const cell = new Vec3(0, 64, 0);
  let bot: Bot;
  let satisfied = false;
  let inventoryGain = 0;
  let ticks = 0;
  bot = fakeBot({
    drops: [cell],
    feet: cell,
    onWaitForTicks: () => {
      ticks += 1;
      if (ticks === 1) delete bot.entities[0];
      if (ticks === 2) {
        inventoryGain = 1;
        satisfied = true;
      }
    },
  });

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      observedInventoryGain: () => inventoryGain,
      route: async (options) => {
        const arrival = {
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        };
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        assert.equal((await options.onArrival?.(arrival))?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 2);
});

test("a confirmed pickup does not linger while another item remains", async () => {
  const cell = new Vec3(0, 64, 0);
  let bot: Bot;
  let inventoryGain = 0;
  let satisfied = false;
  const announcements: string[][] = [];
  bot = fakeBot({
    drops: [cell, cell],
    feet: cell,
    onWaitForTicks: () => {
      if (bot.entities[0]) {
        delete bot.entities[0];
        inventoryGain = 1;
      }
    },
  });

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      observedInventoryGain: () => inventoryGain,
      onTargets: (targets) => {
        announcements.push(
          targets.map((target) =>
            target.kind === "drop" || target.kind === "settling_drop"
              ? `${target.kind}:${target.entityId}`
              : target.kind,
          ),
        );
      },
      route: async (options) => {
        const arrival = {
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        };
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(announcements.at(-1), ["drop:1"]);
});

test("a vanished route target does not blacklist a different live item", async () => {
  const cell = new Vec3(0, 64, 0);
  const bot = fakeBot({ drops: [cell, cell], feet: cell });
  let inventoryGain = 0;
  let routes = 0;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => inventoryGain === 2,
      observedInventoryGain: () => inventoryGain,
      route: async () => {
        routes += 1;
        if (routes === 1) {
          delete bot.entities[0];
          inventoryGain = 1;
          return { status: "stopped", reason: "Entity 0 is not currently observed.", elapsedMs: 0 };
        }
        delete bot.entities[1];
        inventoryGain = 2;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
});

test("a reachable shaft is submitted to search instead of bypassing excavation cost", async () => {
  const target = new Vec3(0, 66, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(0.5, 64, 0.5) });
  let satisfied = false;
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      breakInPlace: async () => {
        throw new Error("shaft mining must not bypass search");
      },
      route: async (options) => {
        routes += 1;
        const goal = options.goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(goal.kind, "active");
        if (goal.kind !== "active") throw new Error("expected mining goal");
        assert.equal(
          goal.isSatisfied({ feet: bot.entity.position, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld),
          false,
        );
        assert.equal(typeof goal.finish, "function");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.equal(routes, 1);
});

test("an airborne bot leaves a reachable shaft target for Pathfinder", async () => {
  const target = new Vec3(0, 65, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(0.5, 64, 0.5), onGround: false });
  let breakAttempts = 0;
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      breakInPlace: async () => {
        breakAttempts += 1;
        return { status: "broken" };
      },
      route: async () => {
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(breakAttempts, 0);
});

test("standing inside an upward vein does not declare its excavation complete", async () => {
  const lower = new Vec3(5, 64, 0);
  const upper = new Vec3(5, 65, 0);
  const bot = fakeBot({
    blocks: [lower, upper],
    solids: [new Vec3(5, 62, 0), new Vec3(5, 63, 0), new Vec3(5, 66, 0)],
  });
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const snapshot = options.goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(snapshot.kind, "active");
        if (snapshot.kind !== "active") throw new Error("expected active mining goal");
        const node = (feet: Vec3) => ({ feet, remainingScaffolds: [], overlayId: "overlay:0" }) as never;
        assert.equal(snapshot.isSatisfied(node(new Vec3(5, 62, 0)), goalTestWorld), false);
        assert.equal(snapshot.isSatisfied(node(lower), goalTestWorld), false);
        assert.equal(typeof snapshot.finish, "function");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

test("a target the movement policy cannot mine is reported as observed but unmineable", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "prohibited", reason: "3 lava faces, 1 block carried" }),
      route: async () => {
        routes += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
  // The numbers, not "the movement policy": this is what the model reads.
  assert.equal(result.reason, "1 loaded matching block(s) cannot be mined: 3 lava faces, 1 block carried");
  assert.equal(routes, 0);
});

test("rejection reasons are counted separately so one bad tool does not hide a lava face", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0), new Vec3(6, 64, 0), new Vec3(7, 64, 0)] });
  const result = await mine(
    bot,
    request(bot, {
      canMine: (block) => ({
        kind: "prohibited",
        reason: block.position.x === 5 ? "no carried tool can harvest this block" : "2 lava faces, 0 blocks carried",
      }),
    }),
  );

  assert.equal(result.status, "unreachable");
  assert.equal(
    result.reason,
    "3 loaded matching block(s) cannot be mined: 2 lava faces, 0 blocks carried (×2); no carried tool can harvest this block",
  );
});

/**
 * The whole point of the seal step: a target the route may not break is walked
 * to, its lava faces are closed with carried blocks, and only then is it broken
 * where the bot stands.
 */
test("a target the route may not break is sealed and broken in place", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], lava: [new Vec3(2, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  const sealed: string[] = [];
  let broken = 0;

  const result = await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken > 0,
      placeInto: async (_bot, cell) => {
        sealed.push(`${cell.x},${cell.y},${cell.z}`);
        (bot as Bot & { removeLava(cell: Vec3): boolean }).removeLava(new Vec3(cell.x, cell.y, cell.z));
        return { kind: "placed", block: {} as never };
      },
      breakInPlace: async (options) => {
        (bot as Bot & { removeBlock(cell: Vec3): boolean }).removeBlock(
          new Vec3(options.position.x, options.position.y, options.position.z),
        );
        broken += 1;
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("a target already in reach must not be routed to");
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(sealed, ["2,64,0"]);
  assert.equal(broken, 1);
});

test("a wet target already in reach can be mined while floating", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(0.5, 64, 0.5), onGround: false, isInWater: true });
  let broken = false;
  const result = await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken,
      breakInPlace: async () => {
        broken = true;
        (bot as FakeWorld).removeBlock(target);
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("The floating working stance is already in reach.");
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.equal(broken, true);
});

test("incidental inventory gain cannot satisfy an unbroken exact target", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(0.5, 64, 0.5) });
  const result = await mine(
    bot,
    request(bot, {
      exactTarget: target,
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => true,
      observedInventoryGain: () => 1,
      breakInPlace: async () => {
        (bot as FakeWorld).removeBlock(target);
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("The named target is already in reach.");
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

test("failed water preparation excludes the attempted working cell even after the bot sinks", async () => {
  const target = new Vec3(1, 64, 0);
  const attempted = new Vec3(0, 64, 0);
  const bot = fakeBot({ blocks: [target], feet: attempted.offset(0.5, 0, 0.5), isInWater: true, onGround: false });
  const blockAt = bot.blockAt.bind(bot);
  bot.blockAt = (position) => {
    const block = blockAt(position);
    return position.equals(attempted) && block
      ? Object.assign(block, { name: "water", stateId: 5, getProperties: () => ({ level: 1 }) })
      : block;
  };
  const physics = new EventEmitter();
  bot.on = (event, listener) => {
    physics.on(event, listener);
    return bot;
  };
  bot.off = (event, listener) => {
    physics.off(event, listener);
    return bot;
  };
  let inspected = false;
  const clock = setInterval(() => {
    bot.entity.position.y = 63.1;
    physics.emit("physicsTick");
  }, 1);
  try {
    await mine(
      bot,
      request(bot, {
        canMine: () => ({ kind: "mineable", routeMayBreak: false }),
        isSatisfied: () => inspected,
        route: async ({ goal }) => {
          const resolved = goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
          assert.equal(resolved.kind, "active");
          if (resolved.kind !== "active") throw new Error("Expected remaining working positions");
          assert.equal(
            resolved.isSatisfied({ feet: attempted, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld),
            false,
          );
          inspected = true;
          return { status: "completed", elapsedMs: 0 };
        },
      }),
    );
    assert.equal(inspected, true);
  } finally {
    clearInterval(clock);
  }
});

test("a collected item disappearing from a route does not blacklist its remaining block target", async () => {
  const target = new Vec3(5, 64, 0);
  const bot = fakeBot({ blocks: [target] });
  let gained = 0;
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      exactTarget: target,
      isSatisfied: () => gained >= 1,
      observedInventoryGain: () => gained,
      route: async () => {
        routes += 1;
        if (routes === 1) {
          gained = 1;
          return { status: "stopped", reason: "Entity 42 is not currently observed.", elapsedMs: 0 };
        }
        (bot as FakeWorld).removeBlock(target);
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(routes, 2);
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

/**
 * A target the route may not break is worked from a cell that touches it. The
 * cells *below* it are not offered: for a slab under standing water the
 * cheapest of them is a flooded pit the bot digs itself into.
 */
test("a target the route may not break is approached from the cells that touch it", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(5.5, 64, 5.5) });
  const stands = (feet: Vec3) => ({ feet, remainingScaffolds: [], overlayId: "overlay:0" }) as never;

  await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      route: async (options) => {
        const goal = options.goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(goal.kind, "active");
        if (goal.kind !== "active") throw new Error("unreachable");
        assert.equal(goal.isSatisfied(stands(new Vec3(1, 65, 0)), goalTestWorld), true);
        assert.equal(goal.isSatisfied(stands(new Vec3(2, 64, 0)), goalTestWorld), true);
        assert.equal(goal.isSatisfied(stands(new Vec3(1, 63, 0)), goalTestWorld), false);
        assert.equal(goal.isSatisfied(stands(new Vec3(2, 65, 0)), goalTestWorld), true);
        return { status: "stopped", reason: "test stop", elapsedMs: 0 };
      },
    }),
  );
});

/**
 * A shore beside a pool level with its own floor, which is what both flat cast
 * fixtures and every generated pool look like: the bot stands on 0,64,0, the
 * lava fills 1..2,64,0 and its floor is the layer under it. The pour is aimed
 * at that floor *through* the near source, so the water lands in the source
 * cell itself and the source beside it turns to obsidian.
 */
function castShore(carrying: { name: string }[]): Bot {
  return fakeBot({
    lava: [new Vec3(1, 64, 0), new Vec3(2, 64, 0)],
    solids: [new Vec3(0, 64, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)],
    carrying,
    feet: new Vec3(0.5, 65, 0.5),
  });
}

test("an occluded working stance is removed instead of repeating the same arrival", async () => {
  const bot = fakeBot({ blocks: [new Vec3(1, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  bot.world.raycast = () => null;
  let checked = false;
  await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => checked,
      route: async (options) => {
        const observation = { position: bot.entity.position, entities: new Map() } as never;
        const node = { feet: bot.entity.position.floored(), remainingScaffolds: 0, overlayId: "overlay:0" };
        const before = options.goal.resolve(observation);
        assert.equal(before.kind === "active" && before.isSatisfied(node, goalTestWorld), true);
        await options.onArrival?.({ goalRevision: "test", node, observation, signal: new AbortController().signal });
        const after = options.goal.resolve(observation);
        assert.equal(after.kind === "active" && after.isSatisfied(node, goalTestWorld), false);
        assert.equal(
          after.kind === "active" && after.isSatisfied({ ...node, feet: new Vec3(2, 63, 0) }, goalTestWorld),
          true,
        );
        checked = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(checked, true);
});

test("liquid-adjacent mining leaves the pickup hole before a submerged dig", async () => {
  const bot = fakeBot({ blocks: [new Vec3(1, 64, 0)], feet: new Vec3(5.5, 65, 5.5) });
  (bot as FakeWorld).addWater(new Vec3(2, 65, 0));
  let inspected = false;
  await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => inspected,
      route: async ({ goal }) => {
        const resolved = goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(resolved.kind, "active");
        if (resolved.kind !== "active") throw new Error("missing target");
        const node = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
        assert.equal(resolved.isSatisfied(node(new Vec3(2, 64, 0)), goalTestWorld), false);
        assert.equal(resolved.isSatisfied(node(new Vec3(2, 65, 0)), goalTestWorld), true);
        inspected = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(inspected, true);
});

const obsidianRequest = {
  matches: (block: { name: string }) => block.name === "obsidian",
  matchingStateIds: new Set([5]),
};

test("an unusable pour stance leaves the pool available from another stance", async () => {
  const bot = castShore([{ name: "water_bucket" }]);
  bot.world.raycast = () => null;
  let inspected = false;
  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      isSatisfied: () => inspected,
      cast: async () => {
        throw new Error("no ray means no bucket use");
      },
      route: async ({ goal }) => {
        const resolved = goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(resolved.kind, "active");
        if (resolved.kind !== "active") throw new Error("pool was discarded");
        const node = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
        assert.equal(resolved.isSatisfied(node(new Vec3(0, 65, 0)), goalTestWorld), false);
        assert.equal(resolved.isSatisfied(node(new Vec3(1, 65, 1)), goalTestWorld), true);
        assert.equal(resolved.isSatisfied(node(new Vec3(0, 64, 0)), goalTestWorld), false);
        inspected = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.equal(inspected, true);
});

/**
 * Obsidian is the one block a bot can manufacture, so a pool is a target like
 * any other: the route walks to its lip, the loop pours where it arrives, and
 * what forms is mined by the same loop that mines ore.
 */
test("a pool is poured on where the route left the bot, and what forms is mined", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot as FakeWorld;
  const uses: string[] = [];
  let waterLanding: Vec3 | null = null;
  let broken = 0;

  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      isSatisfied: () => broken > 0,
      cast: async (_bot, use) => {
        uses.push(use.item.name);
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          for (const cell of use.expectedCells ?? []) {
            waterLanding = new Vec3(cell.position.x, cell.position.y, cell.position.z);
            assert.notEqual(bot.blockAt(waterLanding)?.name, "lava", "casting must not replace its raw material");
            world.addWater(waterLanding);
          }
          // The source beside the water is what turns to obsidian.
          world.removeLava(new Vec3(2, 64, 0));
          world.addObsidian(new Vec3(2, 64, 0));
        } else {
          carrying[0] = { name: "water_bucket" };
          assert.notEqual(waterLanding, null);
          world.removeWater(waterLanding!);
        }
        return { kind: "used" };
      },
      route: async () => {
        // Mining is pathing: the route breaks the target on its way into it.
        if (bot.blockAt(new Vec3(2, 64, 0))?.name === "obsidian") {
          world.removeObsidian(new Vec3(2, 64, 0));
          broken += 1;
        }
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  // The pour, then the scoop that gets the bucket back.
  assert.deepEqual(uses, ["water_bucket", "bucket"]);
  assert.equal(broken, 1);
  assert.deepEqual(carrying, [{ name: "water_bucket" }]);
});

test("a failed scoop is recovered before mining the cast obsidian", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot as FakeWorld;
  let scoops = 0;
  let broken = 0;
  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      isSatisfied: () => broken > 0,
      cast: async (_bot, use) => {
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          for (const cell of use.expectedCells ?? []) {
            const position = new Vec3(cell.position.x, cell.position.y, cell.position.z);
            world.removeLava(position);
            world.addWater(position);
          }
          world.removeLava(new Vec3(2, 64, 0));
          world.addObsidian(new Vec3(2, 64, 0));
        } else {
          scoops += 1;
          assert.equal(broken, 0, "recover water before mining resumes");
          if (scoops <= 2) {
            // The source can remain visible above the feet after the pour.
            bot.entity.position = new Vec3(0.5, 63, 0.5);
            bot.world.raycast = () => null;
            return { kind: "failed", error: "the original scoop ray missed" };
          }
          carrying[0] = { name: "water_bucket" };
          world.removeWater(new Vec3(1, 64, 0));
        }
        return { kind: "used" };
      },
      route: async () => {
        assert.equal(scoops, 3);
        world.removeObsidian(new Vec3(2, 64, 0));
        broken += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.equal(scoops, 3);
  assert.equal(carrying[0]?.name, "water_bucket");
});

test("an unrecoverable cast source cannot be hidden by reaching the inventory quantity", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot as FakeWorld;
  let enough = false;
  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      isSatisfied: () => enough,
      cast: async (_bot, use) => {
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          world.removeLava(new Vec3(2, 64, 0));
          world.addObsidian(new Vec3(2, 64, 0));
          enough = true; // An incidental pickup can satisfy quantity during preparation.
          return { kind: "used" };
        }
        return { kind: "failed", error: "source vanished" };
      },
      route: async () => {
        throw new Error("a missing source must fail before further movement");
      },
    }),
  );
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /source is no longer observed/);
});

test("a pour the server refuses gives up on the whole pool, not on one source of it", async () => {
  const bot = castShore([{ name: "water_bucket" }]);
  let pours = 0;

  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      cast: async () => {
        pours += 1;
        return { kind: "failed", error: "the server refused the use" };
      },
    }),
  );

  assert.equal(pours, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the lava at 1,64,0 could not be cast: the server refused the use/);
});

test("a pour that formed no obsidian gives up on the pool", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot as FakeWorld;
  let pours = 0;

  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      cast: async (_bot, use) => {
        if (use.item.name !== "water_bucket") {
          carrying[0] = { name: "water_bucket" };
          return { kind: "used" };
        }
        pours += 1;
        carrying[0] = { name: "bucket" };
        for (const cell of use.expectedCells ?? []) {
          world.removeLava(new Vec3(cell.position.x, cell.position.y, cell.position.z));
          world.addWater(new Vec3(cell.position.x, cell.position.y, cell.position.z));
        }
        return { kind: "used" };
      },
    }),
  );

  assert.equal(pours, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the pour into 0,65,0 formed no obsidian/);
});

test("lava is not a target without the water to pour on it", async () => {
  const bot = castShore([{ name: "diamond_pickaxe" }]);

  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      cast: async () => {
        throw new Error("an empty-handed run must not reach the pour");
      },
    }),
  );

  assert.equal(result.status, "no_targets");
});

test("a lava face that will not close blacklists the target instead of breaking it", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], lava: [new Vec3(2, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  let breaks = 0;

  const result = await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      placeInto: async () => ({ kind: "failed", error: "no carried item is a full block" }),
      breakInPlace: async () => {
        breaks += 1;
        return { status: "broken" };
      },
      route: async () => ({ status: "completed", elapsedMs: 0 }),
    }),
  );

  assert.equal(breaks, 0);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the lava at 2,64,0 could not be closed: no carried item is a full block/);
});

test("a quantity already in hand is not mined for", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => true,
      route: async () => {
        routes += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 0);
});

/**
 * The stall that failed every mining scenario. A route that reports arrival
 * without changing the world must not be asked the same question again — a
 * target the bot occupies has to be given up so the run can end.
 */
test("a route that arrives without breaking anything cannot loop forever", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      route: async () => {
        routes += 1;
        assert.ok(routes < 200, "the loop ran away instead of giving up on an unreachable target");
        return { status: "stopped", reason: "no route was found", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
  assert.equal(result.reason, "no route was found");
});

test("an unreachable target is reported as found-but-unreachable, not as absent", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  const result = await mine(
    bot,
    request(bot, { route: async () => ({ status: "stopped", reason: "no path", elapsedMs: 0 }) }),
  );

  assert.notEqual(result.status, "no_targets");
  assert.equal(result.status, "unreachable");
});

test("an exact target remains available beyond the general scan's nearest-match limit", async () => {
  const target = new Vec3(15, 64, 15);
  const nearer = Array.from(
    { length: 256 },
    (_, index) => new Vec3(index % 8, 64 + Math.floor(index / 64), Math.floor(index / 8) % 8),
  );
  const bot = fakeBot({ blocks: [target, ...nearer] });
  const offered: string[] = [];

  const result = await mine(
    bot,
    request(bot, {
      exactTarget: target,
      onTargets: async (targets) => {
        offered.push(...targets.map(({ position }) => `${position.x},${position.y},${position.z}`));
      },
      route: async () => ({ status: "stopped", reason: "test stop", elapsedMs: 0 }),
    }),
  );

  assert.equal(result.status, "unreachable");
  assert.deepEqual([...new Set(offered)], ["15,64,15"]);
});

test("planner snapshots reuse the composed mining goal without constructing more blocks", async () => {
  let blockReads = 0;
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)], onBlockRead: () => (blockReads += 1) });
  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        assert.equal(typeof options.onArrival, "function");
        const beforeSnapshots = blockReads;
        const observed = { position: new Vec3(0.5, 64, 0.5), entities: new Map() } as never;
        options.goal.resolve(observed);
        options.goal.resolve(observed);
        assert.equal(blockReads, beforeSnapshots);
        return { status: "stopped", reason: "test stop", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
});

test("the mining process does not expire a productive route on a wall-clock timer", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        assert.equal(options.timeoutMs, undefined);
        return { status: "stopped", reason: "test stop", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
});

test("a calculation failure blacklists the target nearest the bot's current position", async () => {
  const first = new Vec3(5, 64, 0);
  const second = new Vec3(14, 64, 0);
  const bot = fakeBot({ blocks: [first, second] });
  const announcements: string[][] = [];
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      onTargets: (targets) => {
        announcements.push(targets.map((target) => `${target.position.x}`));
      },
      route: async (options) => {
        bot.entity.position = new Vec3(13.5, 64, 0.5);
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 13, y: 64, z: 0 },
              heuristic: 1,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(announcements, [["5", "14"], ["5"]]);
});

test("an unreachable drop is blacklisted without delaying the remaining block target", async () => {
  let ticks = 0;
  const bot = fakeBot({
    blocks: [new Vec3(1, 64, 0)],
    drops: [new Vec3(10, 64, 0)],
    feet: new Vec3(0.5, 64, 0.5),
    onWaitForTicks: () => {
      ticks += 1;
    },
  });
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 1,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 0);
});

test("an unreachable live drop does not wait forever for a packet transition", async () => {
  const bot = fakeBot({
    drops: [new Vec3(3, 61, 0)],
    onWaitForTicks: () => {
      throw new Error("a live unreachable drop must not loiter");
    },
  });
  let failures = 0;
  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        failures += 1;
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 3,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(failures, 1);
  assert.equal(result.status, "unreachable");
});

test("a failed pickup search waits for a falling log to land before judging its reachability", async () => {
  let ticks = 0;
  let satisfied = false;
  const bot = fakeBot({
    drops: [new Vec3(3, 67.5, 0)],
    solids: [new Vec3(3, 63, 0)],
    onWaitForTicks: () => {
      ticks += 1;
      bot.entities[0]!.position.y = ticks === 3 ? 64 : 67.5 - ticks;
    },
  });
  bot.entities[0]!.velocity = new Vec3(0, -0.2, 0);
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 3,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(ticks, 3);
        assert.equal(resolution?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
});

test("a moving drop in lava does not receive the free-flight wait", async () => {
  const cell = new Vec3(3, 61, 0);
  const bot = fakeBot({
    drops: [cell],
    lava: [cell],
    onWaitForTicks: () => {
      throw new Error("lava is not free flight");
    },
  });
  bot.entities[0]!.velocity = new Vec3(0, -0.2, 0);
  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        const resolution = await options.onCalculationFailure?.({
          failure: {
            kind: "no_path",
            search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
            closest: {
              position: { x: 0, y: 64, z: 0 },
              heuristic: 3,
              routeCost: 0,
              basis: "best_heuristic_search_node",
            },
          },
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        });
        assert.equal(resolution?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "unreachable");
});

test("a failed block cell does not hide an item that later lands there", async () => {
  const cell = new Vec3(5, 64, 0);
  const bot = fakeBot({ blocks: [cell] });
  let routes = 0;
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        routes += 1;
        if (routes === 1) {
          const resolution = await options.onCalculationFailure?.({
            failure: {
              kind: "no_path",
              search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
              closest: {
                position: cell,
                heuristic: 1,
                routeCost: 0,
                basis: "best_heuristic_search_node",
              },
            },
            observation: { position: bot.entity.position } as never,
            signal: new AbortController().signal,
          });
          assert.equal(resolution?.kind, "completed");
          (bot as Bot & { removeBlock(position: Vec3): boolean }).removeBlock(cell);
          bot.entities[7] = fakeItemEntity(7, cell);
          return { status: "completed", elapsedMs: 0 };
        }

        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
});

test("an old item does not hide a later item entering the same cell", async () => {
  const cell = new Vec3(0, 64, 0);
  let bot: Bot;
  let ticks = 0;
  let satisfied = false;
  bot = fakeBot({
    drops: [cell],
    feet: cell,
    onWaitForTicks: async () => {
      ticks += 1;
      if (ticks !== 1) return;
      await new Promise((resolve) => setTimeout(resolve, 1_550));
      delete bot.entities[0];
      bot.entities[1] = fakeItemEntity(1, cell);
    },
  });

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const arrival = {
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        };
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 2);
});

test("the 64-target goal width is not a lifetime calculation-failure limit", async () => {
  const blocks = Array.from({ length: 65 }, (_, index) => new Vec3((index % 15) + 1, 64, Math.floor(index / 15)));
  const bot = fakeBot({ blocks });
  let failures = 0;
  let routes = 0;

  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        routes += 1;
        for (;;) {
          failures += 1;
          assert.ok(failures <= blocks.length, "the process retried without consuming a target");
          const resolution = await options.onCalculationFailure?.({
            failure: {
              kind: "no_path",
              search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
              closest: {
                position: { x: 0, y: 64, z: 0 },
                heuristic: 1,
                routeCost: 0,
                basis: "best_heuristic_search_node",
              },
            },
            observation: { position: bot.entity.position } as never,
            signal: new AbortController().signal,
          });
          if (resolution?.kind === "completed") break;
        }
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
  assert.equal(routes, 1);
  assert.equal(failures, 65);
});

test("a live drop remains a target after the vanished-item settlement window", async () => {
  let ticks = 0;
  let satisfied = false;
  const bot = fakeBot({
    drops: [new Vec3(0, 64, 0)],
    feet: new Vec3(0, 64, 0),
    onWaitForTicks: async () => {
      ticks += 1;
      if (ticks === 1) await new Promise((resolve) => setTimeout(resolve, 1_550));
    },
  });
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      route: async (options) => {
        const arrival = {
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        };
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 2);
});

/**
 * The five-minute stand: an item the inventory cannot take stays a live drop
 * target, the pickup goal is satisfied where the bot stands, and nothing ends
 * the arrival until the server despawns the item. The overlap itself is the
 * evidence: past vanilla's pickup delay, an item still under the bot is not
 * coming in.
 */
test("a drop the bot stands in without gaining anything is given up before the server despawns it", async () => {
  const cell = new Vec3(0, 64, 0);
  let ticks = 0;
  const bot = fakeBot({
    drops: [cell],
    feet: cell,
    onWaitForTicks: async () => {
      ticks += 1;
      if (ticks === 1) await new Promise((resolve) => setTimeout(resolve, DROP_PICKUP_TIMEOUT_MS + 50));
    },
  });
  // The overlap is judged against the item's pickup box, which the fake must carry.
  Object.assign(bot.entities[0]!, { width: 0.25, height: 0.25 });

  const result = await mine(
    bot,
    request(bot, {
      route: async (options) => {
        const arrival = {
          goalRevision: "test",
          node: {} as never,
          observation: { position: bot.entity.position } as never,
          signal: new AbortController().signal,
        };
        assert.equal((await options.onArrival?.(arrival))?.kind, "continue");
        assert.equal((await options.onArrival?.(arrival))?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(ticks, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the stone drop at 0,64,0 was not picked up after 3 s in reach/);
});

test("mining stops once the requested quantity arrives mid-route", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0)] });
  let held = 0;
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => held >= 1,
      route: async () => {
        held = 1;
        return { status: "stopped", reason: "the requested quantity is in the inventory", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});
