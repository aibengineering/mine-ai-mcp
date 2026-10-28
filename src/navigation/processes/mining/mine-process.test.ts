import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { Goal } from "../../goals/goal.js";
import type { NavigationArrival, NavigationCalculationFailureEvent } from "../../orchestration/process-events.js";
import type { BlockPosition } from "../../world/world.js";
import { raycastThrough } from "../../../test-support/world.js";
import { DROP_PICKUP_TIMEOUT_MS } from "./mine-drops.js";
import { mine, type MineRequest } from "./mine-process.js";

const goalTestWorld = new GoalTestWorld();

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
}): FakeWorld {
  const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
  const blocks = new Set((options.blocks ?? []).map(key));
  const solids = new Set((options.solids ?? []).map(key));
  const lava = new Set((options.lava ?? []).map(key));
  const obsidian = new Set<string>();
  const water = new Set<string>();
  const flowing = new Set<string>();
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
      // Any state above the source's is flow.
      if (flowing.has(at)) return block("water", 6, "empty", false);
      return block("air", 0, "empty");
    },
    removeBlock: (cell: Vec3) => blocks.delete(key(cell)),
    addBlock: (cell: Vec3) => blocks.add(key(cell)),
    removeObsidian: (cell: Vec3) => obsidian.delete(key(cell)),
    addObsidian: (cell: Vec3) => obsidian.add(key(cell)),
    removeLava: (cell: Vec3) => lava.delete(key(cell)),
    addWater: (cell: Vec3) => water.add(key(cell)),
    removeWater: (cell: Vec3) => water.delete(key(cell)),
    addFlowingWater: (cell: Vec3) => flowing.add(key(cell)),
    removeFlowingWater: (cell: Vec3) => flowing.delete(key(cell)),
  } as unknown as FakeWorld;
}

/** The world mutators a test uses to play the server's side of a break or a cast. */
type FakeWorld = Bot & {
  addBlock(cell: Vec3): void;
  removeBlock(cell: Vec3): void;
  addObsidian(cell: Vec3): void;
  removeObsidian(cell: Vec3): void;
  removeLava(cell: Vec3): void;
  addWater(cell: Vec3): void;
  removeWater(cell: Vec3): void;
  addFlowingWater(cell: Vec3): void;
  removeFlowingWater(cell: Vec3): void;
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
    requested: Number.POSITIVE_INFINITY,
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

/** `goal` resolved where the bot now stands, failing the test unless it is still active. */
function activeGoal(bot: Bot, goal: Goal, expected = "an active mining goal") {
  const resolved = goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
  assert.equal(resolved.kind, "active", expected);
  if (resolved.kind !== "active") throw new Error("unreachable");
  return resolved;
}

/** The route reaching the current goal where the bot now stands. */
function arrivalAt(bot: Bot): NavigationArrival {
  return {
    goalRevision: "test",
    node: {} as never,
    observation: { position: bot.entity.position } as never,
    signal: new AbortController().signal,
  };
}

/** A one-node search that found no path and ended at `closest`, observed where the bot now stands. */
function noPath(bot: Bot, closest: BlockPosition = { x: 0, y: 64, z: 0 }): NavigationCalculationFailureEvent {
  return {
    failure: {
      kind: "no_path",
      search: { queued: 0, visited: 1, generated: 1, slices: 1, computeMs: 1 },
      closest: { position: closest, heuristic: 1, routeCost: 0, basis: "best_heuristic_search_node" },
    },
    observation: { position: bot.entity.position } as never,
    signal: new AbortController().signal,
  };
}

/**
 * A clock for the request's `now`, which times the target refresh interval and
 * every drop deadline, so a test skips those waits by advancing it instead of
 * sleeping through them. Real time still runs underneath the offset.
 */
function testClock(): { now(): number; advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
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
        const resolution = await options.onCalculationFailure?.(noPath(bot));
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
  const clock = testClock();
  const bot = fakeBot({});
  const target = new Vec3(5, 64, 0);
  let satisfied = false;

  const result = await mine(
    bot,
    request(bot, {
      now: clock.now,
      explore: true,
      isSatisfied: () => satisfied,
      route: async (options) => {
        const branch = activeGoal(bot, options.goal);
        assert.match(branch.revision, /^mine-branch:/);

        bot.addBlock(target);
        clock.advance(260);

        const ore = activeGoal(bot, options.goal);
        assert.doesNotMatch(ore.revision, /^mine-branch:/);
        assert.match(ore.revision, /5,64,0/);

        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

test("a route that sees only refused blocks left does not turn into exploring", async () => {
  // collect/waterfall-oak, NoMaterial, 2026-10-22: with no dirt, the logs
  // under the waterfall are refused for want of isolation material. The last
  // dry log's drop was taken while its pickup route was still running, and
  // that route's next look found only the two refused logs. It switched to
  // the exploration goal, which the process itself refuses while matching
  // blocks are refused, and walked off for two minutes instead of reporting
  // the partial collection beside the tree.
  const clock = testClock();
  const refused = new Vec3(5, 64, 0);
  const bot = fakeBot({ blocks: [refused], drops: [new Vec3(2.5, 64, 0.5)] });
  let routes = 0;
  let gained = 0;
  const result = await mine(
    bot,
    request(bot, {
      now: clock.now,
      explore: true,
      observedInventoryGain: () => gained,
      canMine: () => ({ kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket" }),
      route: async (options) => {
        routes += 1;
        const drop = { id: 0, position: new Vec3(2.5, 64, 0.5), width: 0.25, height: 0.25 };
        const first = options.goal.resolve({ position: bot.entity.position, entities: new Map([[0, drop]]) } as never);
        assert.equal(first.kind, "active", "the drop is the goal");
        delete bot.entities[0];
        gained = 1;
        clock.advance(260);
        const next = options.goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(next.kind, "invalid", next.kind === "active" ? `kept going for ${next.revision}` : "");
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(routes, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /liquid isolation needs/);
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
        bot.removeBlock(target);
        const resolution = await options.onArrival?.(arrivalAt(bot));
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
        const afterFailure = await options.onCalculationFailure?.(noPath(bot));
        assert.equal(afterFailure?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
});

/** What a drop-arrival script can do between ticks: play the server, the clock, or the inventory. */
interface DropArrivalWorld {
  readonly bot: FakeWorld;
  readonly cell: Vec3;
  readonly clock: ReturnType<typeof testClock>;
  gain(): void;
  satisfy(): void;
}

/**
 * The bot stands in the cell of a drop and the route reports arrival there,
 * again and again. Each arrival waits a tick for the server, then reads the
 * cell afresh; `script` plays what happens on each tick, and `arrivals` is
 * what each successive arrival must answer.
 */
const DROP_ARRIVALS: readonly {
  readonly name: string;
  readonly drops: number;
  /** Give the item its pickup box, for rows judged on overlap with the body. */
  readonly pickupBox?: boolean;
  readonly script?: (tick: number, world: DropArrivalWorld) => void;
  readonly arrivals: readonly ("continue" | "completed")[];
  /** Whether the route has what it came for once its arrivals are answered. */
  readonly thenSatisfied: boolean;
  readonly ticks: number | null;
  readonly status: "satisfied" | "unreachable";
  readonly reason?: RegExp;
  /** The drops the last announcement named, as `kind:entityId`. */
  readonly lastAnnounced?: readonly string[];
}[] = [
  {
    name: "an occupied drop arrival yields a server pickup interval before continuing",
    drops: 1,
    arrivals: ["continue"],
    thenSatisfied: true,
    ticks: 1,
    status: "satisfied",
  },
  {
    name: "a vanished item stays pending until Mineflayer applies the inventory packet",
    drops: 1,
    script: (tick, { bot, gain, satisfy }) => {
      if (tick === 1) delete bot.entities[0];
      if (tick === 2) {
        gain();
        satisfy();
      }
    },
    arrivals: ["continue", "completed"],
    thenSatisfied: false,
    ticks: 2,
    status: "satisfied",
  },
  {
    name: "a confirmed pickup does not linger while another item remains",
    drops: 2,
    script: (_tick, { bot, gain }) => {
      if (bot.entities[0]) {
        delete bot.entities[0];
        gain();
      }
    },
    arrivals: ["continue", "continue"],
    thenSatisfied: true,
    ticks: null,
    status: "satisfied",
    lastAnnounced: ["drop:1"],
  },
  {
    name: "an old item does not hide a later item entering the same cell",
    drops: 1,
    script: (tick, { bot, cell, clock }) => {
      if (tick !== 1) return;
      clock.advance(1_550);
      delete bot.entities[0];
      bot.entities[1] = fakeItemEntity(1, cell);
    },
    arrivals: ["continue", "continue"],
    thenSatisfied: true,
    ticks: 2,
    status: "satisfied",
  },
  {
    name: "a live drop remains a target after the vanished-item settlement window",
    drops: 1,
    script: (tick, { clock }) => {
      if (tick === 1) clock.advance(1_550);
    },
    arrivals: ["continue", "continue"],
    thenSatisfied: true,
    ticks: 2,
    status: "satisfied",
  },
  /**
   * The five-minute stand: an item the inventory cannot take stays a live drop
   * target, the pickup goal is satisfied where the bot stands, and nothing ends
   * the arrival until the server despawns the item. The overlap itself is the
   * evidence: past vanilla's pickup delay, an item still under the bot is not
   * coming in.
   */
  {
    name: "a drop the bot stands in without gaining anything is given up before the server despawns it",
    drops: 1,
    // The overlap is judged against the item's pickup box, which the fake must carry.
    pickupBox: true,
    script: (tick, { clock }) => {
      if (tick === 1) clock.advance(DROP_PICKUP_TIMEOUT_MS + 50);
    },
    arrivals: ["continue", "completed"],
    thenSatisfied: false,
    ticks: 1,
    status: "unreachable",
    reason: /the stone drop at 0,64,0 was not picked up after 3 s in reach/,
  },
];

test("standing on a drop, each arrival waits for the server and answers from what the cell then holds", async () => {
  for (const row of DROP_ARRIVALS) {
    const clock = testClock();
    const cell = new Vec3(0, 64, 0);
    let ticks = 0;
    let inventoryGain = 0;
    let satisfied = false;
    const announcements: string[][] = [];
    const bot = fakeBot({
      drops: Array.from({ length: row.drops }, () => cell),
      feet: cell,
      onWaitForTicks: () => {
        ticks += 1;
        row.script?.(ticks, {
          bot,
          cell,
          clock,
          gain: () => (inventoryGain = 1),
          satisfy: () => (satisfied = true),
        });
      },
    });
    if (row.pickupBox) Object.assign(bot.entities[0]!, { width: 0.25, height: 0.25 });

    const result = await mine(
      bot,
      request(bot, {
        now: clock.now,
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
          const arrival = arrivalAt(bot);
          for (const expected of row.arrivals)
            assert.equal((await options.onArrival?.(arrival))?.kind, expected, row.name);
          if (row.thenSatisfied) satisfied = true;
          return { status: "completed", elapsedMs: 0 };
        },
      }),
    );

    assert.equal(result.status, row.status, row.name);
    if (row.ticks !== null) assert.equal(ticks, row.ticks, row.name);
    if (row.reason) assert.match(result.reason ?? "", row.reason, row.name);
    if (row.lastAnnounced) assert.deepEqual(announcements.at(-1), row.lastAnnounced, row.name);
  }
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

test("a drop that vanished before its inventory packet is waited for where the bot stands, not searched for", async () => {
  // The item was last seen above the bot's head, a cell it cannot stand in.
  const clock = testClock();
  let satisfied = false;
  let routes = 0;
  let waits = 0;
  const bot = fakeBot({
    drops: [new Vec3(0, 66, 0)],
    feet: new Vec3(0.5, 64, 0.5),
    onWaitForTicks: () => {
      waits += 1;
      satisfied = true;
    },
  });
  const result = await mine(
    bot,
    request(bot, {
      now: clock.now,
      isSatisfied: () => satisfied,
      route: async (options) => {
        routes += 1;
        delete bot.entities[0];
        clock.advance(300);
        const pending = activeGoal(bot, options.goal);
        assert.equal(pending.revision, "await-pending-drops");
        assert.equal(pending.isSatisfied({ feet: { x: 0, y: 64, z: 0 } } as never, {} as never), true);
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.equal(routes, 1, "the pending drop must not start another route");
  assert.equal(waits, 1);
});

test("standing on a drop in its pickup delay, the blocks beside the bot are mined without moving", async () => {
  const floor = new Vec3(4, 64, 0);
  // The touched drop rests on this block; breaking it would drop the item out of reach.
  const support = new Vec3(5, 65, 0);
  const beside = new Vec3(3, 65, 0);
  const besideHead = new Vec3(3, 66, 0);
  const bot = fakeBot({ blocks: [floor, support, beside, besideHead], drops: [new Vec3(5.5, 66, 0.5)], feet: new Vec3(4.5, 65, 0.5) });
  Object.assign(bot.entities[0]!, { width: 0.25, height: 0.25 });
  const broken: string[] = [];
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => broken.length === 2,
      breakInPlace: async ({ position }) => {
        broken.push(`${position.x},${position.y},${position.z}`);
        bot.removeBlock(new Vec3(position.x, position.y, position.z));
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("blocks in reach beside a touched drop need no route");
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.deepEqual(broken, ["3,65,0", "3,66,0"]);
});

test("drops already enough for the request are waited for, not mined beside", async () => {
  // collect/netherrack-bank, 2026-10-21: breaking beside touched drops while
  // they sat out their pickup delay ran on after those drops already covered
  // the request. The 32nd netherrack arrived with three more lying beside the
  // bot and all 36 breaks spent, so a single drop lost on a ledge ended a run
  // at 31 of 32 with [DROP_RECOVERY_EXHAUSTED] and nothing left to mine with.
  const beside = new Vec3(3, 65, 0);
  const bot = fakeBot({ blocks: [new Vec3(4, 64, 0), new Vec3(5, 65, 0), beside], drops: [new Vec3(5.5, 66, 0.5)], feet: new Vec3(4.5, 65, 0.5) });
  Object.assign(bot.entities[0]!, { width: 0.25, height: 0.25 });
  let gained = 31;
  const result = await mine(
    bot,
    request(bot, {
      requested: 32,
      isSatisfied: () => gained >= 32,
      observedInventoryGain: () => gained,
      breakInPlace: async () => {
        throw new Error("the touched drop is the last item the request needs");
      },
      route: async () => {
        gained = 32;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
});

test("a drop out of reach is still collected before any block beside the bot", async () => {
  const beside = new Vec3(3, 65, 0);
  const bot = fakeBot({ blocks: [new Vec3(4, 64, 0), beside], drops: [new Vec3(7.5, 65, 0.5)], feet: new Vec3(4.5, 65, 0.5) });
  Object.assign(bot.entities[0]!, { width: 0.25, height: 0.25 });
  let satisfied = false;
  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => satisfied,
      breakInPlace: async () => {
        throw new Error("a drop the bot is not touching comes first");
      },
      route: async () => {
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
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
        const goal = activeGoal(bot, options.goal);
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
        const snapshot = activeGoal(bot, options.goal);
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

test("rejection reasons are counted separately so one bad tool does not hide a lava face", async () => {
  const bot = fakeBot({ blocks: [new Vec3(5, 64, 0), new Vec3(6, 64, 0), new Vec3(7, 64, 0)] });
  let routes = 0;
  const result = await mine(
    bot,
    request(bot, {
      canMine: (block) => ({
        kind: "prohibited",
        reason: block.position.x === 5 ? "no carried tool can harvest this block" : "2 lava faces, 0 blocks carried",
      }),
      route: async () => {
        routes += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "unreachable");
  // The numbers, not "the movement policy": this is what the model reads.
  assert.equal(
    result.reason,
    "3 loaded matching block(s) cannot be mined: 2 lava faces, 0 blocks carried (×2); no carried tool can harvest this block",
  );
  // Observed but unmineable is reported without a route being walked to any of them.
  assert.equal(routes, 0);
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
        bot.removeLava(new Vec3(cell.x, cell.y, cell.z));
        return { kind: "placed", block: {} as never };
      },
      breakInPlace: async (options) => {
        bot.removeBlock(
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
        bot.removeBlock(target);
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

test("an in-place break waits for a bot dropping out of drained water to land before swinging", async () => {
  const target = new Vec3(1, 64, 0);
  const bot = fakeBot({ blocks: [target], feet: new Vec3(0.5, 64.3, 0.5), onGround: false });
  // In water when the break is chosen; the cell drains before the swing.
  let wet = true;
  Object.defineProperty(bot.entity, "isInWater", {
    get: () => {
      const was = wet;
      wet = false;
      return was;
    },
  });
  const physics = new EventEmitter();
  Object.assign(bot, { on: physics.on.bind(physics), off: physics.off.bind(physics) });
  let ticks = 0;
  const clock = setInterval(() => {
    ticks += 1;
    if (ticks === 3) Object.assign(bot.entity, { onGround: true, position: new Vec3(0.5, 64, 0.5) });
    physics.emit("physicsTick");
  }, 1);
  let groundedAtSwing: boolean | null = null;
  try {
    const result = await mine(
      bot,
      request(bot, {
        canMine: () => ({ kind: "mineable", routeMayBreak: false }),
        isSatisfied: () => groundedAtSwing !== null,
        breakInPlace: async () => {
          groundedAtSwing = bot.entity.onGround;
          bot.removeBlock(target);
          return { status: "broken" };
        },
        route: async () => {
          throw new Error("the target is already in reach");
        },
      }),
    );
    assert.equal(result.status, "satisfied");
  } finally {
    clearInterval(clock);
  }
  assert.equal(groundedAtSwing, true, "a dig started mid-fall takes five times as long");
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
        bot.removeBlock(target);
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
          const resolved = activeGoal(bot, goal, "Expected remaining working positions");
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
        bot.removeBlock(target);
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
        const goal = activeGoal(bot, options.goal);
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
function castShore(carrying: { name: string }[]): FakeWorld {
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
  bot.addWater(new Vec3(2, 65, 0));
  let inspected = false;
  await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => inspected,
      route: async ({ goal }) => {
        const resolved = activeGoal(bot, goal, "missing target");
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

test("a route goes on from a mined cell under water only once the water has flowed into it", async () => {
  // collect/underwater-sand, 2026-10-22 (uw-tip t00005, and 49678c6's
  // uw-base t00006), shifted 125 up: standing on the pool's floor at
  // 2.528,-60,0.5 with water to its head, the bot broke the sand at 3,-61,0
  // beside its feet. The drop lay at 3.369,-60.801,0.303 in the hole, below
  // the reach of a body on the floor. The pickup route was planned 60 ms after
  // the break, while the hole was still air under the source above it, and a
  // planner that swims only through water found no way down into it: it left
  // the pool over a rim it could not climb back, tunnelled under the floor for
  // the drop, and never reached the last sand. Water arrived 240 ms after the
  // break.
  const hole = new Vec3(3, 64, 0);
  const bot = fakeBot({
    blocks: [hole],
    solids: [new Vec3(2, 64, 0)],
    feet: new Vec3(2.528, 65, 0.5),
    isInWater: true,
    onWaitForTicks: () => {
      if (bot.blockAt(hole)?.name !== "air") return;
      // Vanilla water flows into an opened cell five ticks after the update.
      if (++ticksOpen >= 5) bot.addFlowingWater(hole);
    },
  });
  let ticksOpen = 0;
  // Read as Mineflayer does, by the cell a point lies in, and with water
  // levels: the pool's sources are level 0, the flow falling into the hole 8.
  const plain = bot.blockAt.bind(bot);
  Object.assign(bot, {
    blockAt: (point: Vec3) => {
      const block = plain(point.floored());
      return block?.name === "water" ? { ...block, getProperties: () => ({ level: block.stateId === 4 ? 0 : 8 }) } : block;
    },
  });
  for (const cell of [new Vec3(2, 65, 0), new Vec3(2, 66, 0), new Vec3(3, 65, 0), new Vec3(3, 66, 0)]) bot.addWater(cell);
  let holeOnContinue: string | undefined;
  await mine(
    bot,
    request(bot, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      // A submerged stance is a working cell only for a swimmer whose dig fits a breath.
      movements: {
        allowSwimming: true,
        evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: null }),
        digTimeEstimator: { estimate: () => 75 },
      } as unknown as MineRequest["movements"],
      isSatisfied: () => holeOnContinue !== undefined,
      breakInPlace: async () => {
        bot.removeBlock(hole);
        bot.entities[11] = fakeItemEntity(11, new Vec3(3.369, 64.199, 0.303));
        Object.assign(bot.entities[11]!, { width: 0.25, height: 0.25 });
        return { status: "broken" };
      },
      route: async ({ onArrival }) => {
        const outcome = await onArrival!(arrivalAt(bot));
        assert.equal(outcome.kind, "continue", "the drop is still to be collected");
        holeOnContinue = bot.blockAt(hole)?.name;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(holeOnContinue, "water", "the route was handed back before the water reached the mined cell");
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
        const resolved = activeGoal(bot, goal, "pool was discarded");
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
  const world = bot;
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

test("a scoop is confirmed by the poured source leaving the world, not by the bucket alone", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot;
  let landing: Vec3 | null = null;
  let broken = 0;
  let checked = false;

  await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      isSatisfied: () => broken > 0,
      cast: async (_bot, use) => {
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          const cell = use.expectedCells![0]!.position;
          landing = new Vec3(cell.x, cell.y, cell.z);
          world.addWater(landing);
          world.removeLava(new Vec3(2, 64, 0));
          world.addObsidian(new Vec3(2, 64, 0));
          return { kind: "used" };
        }
        // The inventory packet can arrive before the block update: the hand
        // already holds water while the source still stands in the world.
        carrying[0] = { name: "water_bucket" };
        const expected = use.expectedCells?.find((cell) => landing!.equals(new Vec3(cell.position.x, cell.position.y, cell.position.z)));
        assert.ok(expected, "the scoop names the poured cell");
        assert.equal(expected.matches(bot.blockAt(landing!)!), false, "a standing source is not a completed scoop");
        world.removeWater(landing!);
        assert.equal(expected.matches(bot.blockAt(landing!)!), true);
        checked = true;
        return { kind: "used" };
      },
      route: async () => {
        world.removeObsidian(new Vec3(2, 64, 0));
        broken += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(checked, true);
});

test("a failed scoop is recovered before mining the cast obsidian", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot;
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

test("a scooped cast's leftover flow drains before what it formed is judged", async () => {
  // collect/obsidian-in-rock, LevelCaster, 2026-10-22: a caster with no
  // building block poured on a level pool on arrival and scooped its water
  // back. The flow it left stood on all six new obsidian blocks for a moment,
  // so the next look refused every one for want of isolation material, and
  // the request failed 2.5 s in with the bucket full. The same six were
  // mineable 0.3 s later.
  const carrying = [{ name: "water_bucket" }];
  const pool = [new Vec3(1, 64, 0), new Vec3(2, 64, 0)];
  const spread = pool.map((cell) => cell.offset(0, 1, 0));
  let ticksSinceScoop: number | null = null;
  const bot: FakeWorld = fakeBot({
    lava: pool,
    solids: [new Vec3(0, 64, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)],
    carrying,
    feet: new Vec3(-3.5, 65, 0.5),
    onWaitForTicks: () => {
      if (ticksSinceScoop === null) return;
      ticksSinceScoop += 1;
      // An unfed flow recedes on its own scheduled updates.
      if (ticksSinceScoop === 8) for (const cell of spread) bot.removeFlowingWater(cell);
    },
  });
  let landing: Vec3 | null = null;
  let broken = 0;
  const result = await mine(
    bot,
    request(bot, {
      ...obsidianRequest,
      explore: true,
      isSatisfied: () => broken >= pool.length,
      canMine: (block) =>
        bot.blockAt(block.position.offset(0, 1, 0))?.name === "water" && !carrying.some((item) => item.name === "bucket")
          ? { kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket" }
          : { kind: "mineable", routeMayBreak: true },
      cast: async (_bot, use) => {
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          const cell = use.expectedCells![0]!.position;
          landing = new Vec3(cell.x, cell.y, cell.z);
          bot.addWater(landing);
          for (const source of pool) {
            bot.removeLava(source);
            bot.addObsidian(source);
          }
        } else {
          carrying[0] = { name: "water_bucket" };
          bot.removeWater(landing!);
          for (const cell of spread) bot.addFlowingWater(cell);
          ticksSinceScoop = 0;
        }
        return { kind: "used" };
      },
      route: async (options) => {
        // The route arrives at the pool's lip, and the arrival pours.
        bot.entity.position = new Vec3(0.5, 65, 0.5);
        await options.onArrival?.(arrivalAt(bot));
        assert.equal(carrying[0]?.name, "water_bucket", "the arrival poured and scooped");
        const next = options.goal.resolve({ position: bot.entity.position, entities: new Map() } as never);
        assert.equal(next.kind, "active", "what the pour formed is the route's next goal");
        for (const source of pool) bot.removeObsidian(source);
        broken = pool.length;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );
  assert.equal(result.status, "satisfied");
  assert.deepEqual(carrying, [{ name: "water_bucket" }]);
});

test("an unrecoverable cast source cannot be hidden by reaching the inventory quantity", async () => {
  const carrying = [{ name: "water_bucket" }];
  const bot = castShore(carrying);
  const world = bot;
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
  const world = bot;
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

/** Obsidian beside an unconverted lava source, with the bot on the working cell west of it. */
function obsidianBesideSource(carrying: { name: string }[]): FakeWorld {
  const world = fakeBot({
    lava: [new Vec3(2, 64, 0)],
    solids: [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)],
    carrying,
    feet: new Vec3(0.5, 64, 0.5),
  });
  world.addObsidian(new Vec3(1, 64, 0));
  return world;
}

test("a lava source touching an obsidian target is cast rather than sealed", async () => {
  const carrying = [{ name: "water_bucket" }];
  const world = obsidianBesideSource(carrying);
  const sealed: string[] = [];
  const uses: string[] = [];
  let landing: Vec3 | null = null;
  let broken = 0;

  const result = await mine(
    world,
    request(world, {
      ...obsidianRequest,
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken > 0,
      cast: async (_bot, use) => {
        uses.push(use.item.name);
        if (use.item.name === "water_bucket") {
          carrying[0] = { name: "bucket" };
          const cell = use.expectedCells?.[0]?.position;
          assert.ok(cell);
          landing = new Vec3(cell.x, cell.y, cell.z);
          world.addWater(landing);
          world.removeLava(new Vec3(2, 64, 0));
          world.addObsidian(new Vec3(2, 64, 0));
        } else {
          carrying[0] = { name: "water_bucket" };
          world.removeWater(landing!);
        }
        return { kind: "used" };
      },
      placeInto: async (_bot, cell) => {
        sealed.push(`${cell.x},${cell.y},${cell.z}`);
        return { kind: "placed", block: {} as never };
      },
      breakInPlace: async ({ position }) => {
        world.removeObsidian(new Vec3(position.x, position.y, position.z));
        broken += 1;
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("a target already in reach must not be routed to");
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(uses, ["water_bucket", "bucket"]);
  assert.deepEqual(sealed, [], "the source became obsidian instead of being closed with rock");
  assert.equal(world.blockAt(new Vec3(2, 64, 0))?.name, "obsidian");
});

test("a touching source that cannot be cast is still sealed before the break", async () => {
  const world = obsidianBesideSource([{ name: "water_bucket" }]);
  const sealed: string[] = [];
  let casts = 0;
  let broken = 0;

  const result = await mine(
    world,
    request(world, {
      ...obsidianRequest,
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken > 0,
      cast: async () => {
        casts += 1;
        return { kind: "failed", error: "the server refused the use" };
      },
      placeInto: async (_bot, cell) => {
        sealed.push(`${cell.x},${cell.y},${cell.z}`);
        world.removeLava(new Vec3(cell.x, cell.y, cell.z));
        world.addBlock(new Vec3(cell.x, cell.y, cell.z));
        return { kind: "placed", block: {} as never };
      },
      breakInPlace: async ({ position }) => {
        world.removeObsidian(new Vec3(position.x, position.y, position.z));
        broken += 1;
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("a target already in reach must not be routed to");
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(casts, 1, "one refused pour is enough to fall back to the seal");
  assert.deepEqual(sealed, ["2,64,0"]);
  assert.equal(broken, 1);
});

test("a drop that would fall down an open column into lava gets a floor before the break", async () => {
  const target = new Vec3(1, 66, 0);
  const world = fakeBot({
    blocks: [target],
    solids: [new Vec3(0, 65, 0)],
    lava: [new Vec3(1, 64, 0)],
    feet: new Vec3(0.5, 66, 0.5),
  });
  const sealed: string[] = [];
  let broken = 0;

  const result = await mine(
    world,
    request(world, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken > 0,
      placeInto: async (_bot, cell) => {
        sealed.push(`${cell.x},${cell.y},${cell.z}`);
        return { kind: "placed", block: {} as never };
      },
      breakInPlace: async ({ position }) => {
        assert.deepEqual(sealed, ["1,65,0"], "the floor is placed before the target comes out");
        world.removeBlock(new Vec3(position.x, position.y, position.z));
        broken += 1;
        return { status: "broken" };
      },
      route: async () => {
        throw new Error("a target already in reach must not be routed to");
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(sealed, ["1,65,0"]);
});

test("a route stopped by a failed break gives up that block, not the target nearest the bot", async () => {
  const near = new Vec3(1, 64, 0);
  const far = new Vec3(5, 64, 0);
  const bot = fakeBot({ blocks: [near, far], feet: new Vec3(0.5, 64, 0.5) });
  let routes = 0;
  let broken = 0;
  let offered: string[] = [];

  const result = await mine(
    bot,
    request(bot, {
      isSatisfied: () => broken > 0,
      onTargets: (targets) => {
        offered = targets.map((target) => `${target.position.x},${target.position.y},${target.position.z}`);
      },
      route: async () => {
        routes += 1;
        if (routes === 1) {
          return {
            status: "stopped",
            reason: "repeated_movement_failure: No face of the block at 5,64,0 is in view",
            elapsedMs: 0,
            failedBreak: { x: 5, y: 64, z: 0 },
          };
        }
        assert.deepEqual(offered, ["1,64,0"], "the near block stays a target; the failed one is dropped");
        bot.removeBlock(near);
        broken += 1;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
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
      onTargets: (targets) => {
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
        const resolution = await options.onCalculationFailure?.(noPath(bot, { x: 13, y: 64, z: 0 }));
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
        const resolution = await options.onCalculationFailure?.(noPath(bot));
        assert.equal(resolution?.kind, "continue");
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 0);
});

/**
 * A pickup search that found no path, for one drop in three states. Only a
 * drop falling through air is waited for, because where it lands decides
 * whether it is reachable; a resting drop, or one sinking through lava, is
 * judged at once rather than loitered over.
 */
const FAILED_PICKUP_SEARCHES = [
  {
    name: "an unreachable live drop does not wait forever for a packet transition",
    drop: [3, 61, 0],
    falling: false,
    lava: false,
    floor: null,
    landing: null,
    resolution: "completed",
    status: "unreachable",
  },
  {
    name: "a failed pickup search waits for a falling log to land before judging its reachability",
    drop: [3, 67.5, 0],
    falling: true,
    lava: false,
    floor: [3, 63, 0],
    // Three ticks of fall, then it rests on the floor, reachable.
    landing: { ticks: 3, y: 64 },
    resolution: "continue",
    status: "satisfied",
  },
  {
    name: "a moving drop in lava does not receive the free-flight wait",
    drop: [3, 61, 0],
    falling: true,
    lava: true,
    floor: null,
    landing: null,
    resolution: "completed",
    status: "unreachable",
  },
] as const;

test("a failed pickup search waits only for a drop falling through air", async () => {
  for (const row of FAILED_PICKUP_SEARCHES) {
    const [x, y, z] = row.drop;
    const cell = new Vec3(x, y, z);
    let ticks = 0;
    let routes = 0;
    let satisfied = false;
    const bot = fakeBot({
      drops: [cell],
      solids: row.floor ? [new Vec3(row.floor[0], row.floor[1], row.floor[2])] : [],
      lava: row.lava ? [cell.clone()] : [],
      onWaitForTicks: () => {
        if (!row.landing) throw new Error(`${row.name}: must not wait`);
        ticks += 1;
        bot.entities[0]!.position.y = ticks === row.landing.ticks ? row.landing.y : y - ticks;
      },
    });
    if (row.falling) bot.entities[0]!.velocity = new Vec3(0, -0.2, 0);
    const result = await mine(
      bot,
      request(bot, {
        isSatisfied: () => satisfied,
        route: async (options) => {
          routes += 1;
          const resolution = await options.onCalculationFailure?.(noPath(bot));
          assert.equal(ticks, row.landing?.ticks ?? 0, row.name);
          assert.equal(resolution?.kind, row.resolution, row.name);
          if (row.status === "satisfied") satisfied = true;
          return { status: "completed", elapsedMs: 0 };
        },
      }),
    );
    assert.equal(routes, 1, row.name);
    assert.equal(result.status, row.status, row.name);
  }
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
          const resolution = await options.onCalculationFailure?.(noPath(bot, cell));
          assert.equal(resolution?.kind, "completed");
          bot.removeBlock(cell);
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
          const resolution = await options.onCalculationFailure?.(noPath(bot));
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


test("target observers see block removal and pickup during a route without an arrival callback", async () => {
  const clock = testClock();
  const first = new Vec3(5, 64, 0);
  const second = new Vec3(7, 64, 0);
  const bot = fakeBot({ blocks: [first, second] });
  const announcements: string[][] = [];
  let satisfied = false;
  let gained = 0;
  await mine(bot, request(bot, {
    now: clock.now,
    isSatisfied: () => satisfied,
    observedInventoryGain: () => gained,
    onTargets: (targets) => { announcements.push(targets.map(target => target.kind === "drop" ? `drop:${target.entityId}` : `${target.kind}:${target.position.x}`)); },
    route: async ({ goal }) => {
      const observation = { position: bot.entity.position, entities: new Map() } as never;
      assert.deepEqual(announcements.at(-1), ["block:5", "block:7"]);
      bot.removeBlock(first);
      bot.entities[17] = fakeItemEntity(17, first);
      clock.advance(260);
      goal.resolve(observation);
      assert.deepEqual(announcements.at(-1), ["drop:17"]);
      const count = announcements.length;
      goal.resolve(observation);
      assert.equal(announcements.length, count);
      delete bot.entities[17];
      gained = 1;
      clock.advance(260);
      goal.resolve(observation);
      assert.deepEqual(announcements.at(-1), ["block:7"]);
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  }));
});
