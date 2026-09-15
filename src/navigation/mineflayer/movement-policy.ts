import { bucketAvailable } from "../../navigation/mineflayer/water-landing.js";
import { readNavigationPolicy } from "../../survival/state/navigation-policy.js";
/**
 * The production movement policy: what the bot may dig, place, or step on,
 * and what each costs, answered with Mineflayer's own knowledge of blocks,
 * tools, and dig times.
 *
 * On top of the generic defaults in `movements/policy.ts` this adds the
 * protected crops, the blocks to avoid stepping on, Baritone's rule for
 * breaks that would let liquid into the route, harvest-tool selection, and
 * the terrain penalty that stops a walking bot from tunnelling through walls
 * to save a corner.
 */
import type { Bot } from "mineflayer";
import { occupiedCell } from "../../world/placement.js";
import { enchantmentsOf } from "../../world/enchantments.js";
import { DEFAULT_SCAFFOLD_BLOCKS } from "../../survival/policy/contract.js";
import type { BreakEvaluation, MovementPolicy, PolicyDecision, ToolSelection } from "../movements/policy.js";
import { BREAK_OPENS_INTO_LIQUID, createMovementPolicy, type ScaffoldSelection } from "../movements/policy.js";
import { TRAIT_DAMAGING, TRAIT_LAVA } from "../world/block-geometry.js";
import {
  packKey,
  type BlockObservation,
  type BlockPosition,
  type LoadedBlock,
  type WorldView,
} from "../world/world.js";
import { blockClass, observeMineflayerBlock } from "./world.js";

/** The only carried blocks standard navigation may spend to create a route: the cheap, plentiful block of each terrain. */
export const STANDARD_SCAFFOLD_ITEMS = DEFAULT_SCAFFOLD_BLOCKS;

export function scaffoldBlockNames(bot: Bot): readonly string[] {
  return readNavigationPolicy(bot).scaffold_blocks;
}

/** First carried block admitted by the policy's explicit preference order. */
export function preferredScaffoldItem(bot: Bot, protectedNames: ReadonlySet<string> = new Set()) {
  const carried = bot.inventory.items();
  for (const name of scaffoldBlockNames(bot)) {
    if (protectedNames.has(name)) continue;
    const item = carried.find((candidate) => candidate.name === name);
    if (!item) continue;
    const block = bot.registry.blocksByName[name];
    if (!block) continue;
    const { geometry, traits } = observeMineflayerBlock(blockClass(bot).fromStateId(block.defaultState, 0));
    if (geometry.fullCube && geometry.safeSupport && !traits.interactive && !traits.falling && traits.liquid === null)
      return item;
  }
  return null;
}
const ROUTE_PROTECTED_CROPS = [
  "wheat",
  "carrots",
  "potatoes",
  "beetroots",
  "melon_stem",
  "pumpkin_stem",
  "attached_melon_stem",
  "attached_pumpkin_stem",
  "torchflower_crop",
  "pitcher_crop",
  "sweet_berry_bush",
  "nether_wart",
  "cocoa",
] as const;
const AVOID_BLOCKS = ["fire", "soul_fire", "cobweb", "lava", "bubble_column"] as const;

type WorldBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

export interface MineflayerMovementPolicyOptions {
  readonly protectedBlockNames?: readonly string[];
  readonly protectedScaffoldNames?: readonly string[];
  readonly scaffolding?: boolean;
  /** Additional route cost per placed block. Standard navigation uses 20. */
  readonly placementPenalty?: number;
  readonly allowDigging?: boolean;
  readonly maximumDrop?: number;
  readonly allowParkour?: boolean;
  readonly allowDiagonalAscend?: boolean;
  readonly allowDoors?: boolean;
  /** Whether this block and cell are explicitly targeted for removal by the calling task. */
  readonly isRequestedBreak?: (
    block: Extract<BlockObservation, { kind: "loaded" }>,
    position: BlockPosition,
  ) => boolean;
  readonly allowSprinting?: boolean;
  readonly requireHarvestTool?: boolean;
  /** What one break costs beyond its dig time. Defaults to `TERRAIN_BREAK_PENALTY`. */
  readonly breakPenalty?: number;
  /** Cells a route may never dig, as packed keys: the blocks of a structure being built. */
  readonly protectedCells?: ReadonlySet<number>;
}

/** Whether the cell holds water or lava, and whether as a source; null when it holds neither or is not loaded. */
function liquidAt(world: WorldView, x: number, y: number, z: number): "source" | "flowing" | null {
  const block = world.blockAt(x, y, z);
  if (block.kind !== "loaded" || block.traits.liquid === null) return null;
  return block.traits.liquidSource ? "source" : "flowing";
}

/**
 * Whether removing this block would let an adjacent liquid enter the route.
 *
 * Start with Baritone's default `avoidBreaking` liquid rule: any liquid directly
 * above is unsafe; a horizontal source is unsafe; and horizontal flowing
 * liquid is unsafe unless it already continues downward in its own column.
 * An empty cell above also connects the excavation to liquid beside that cell:
 * the new drop can redirect a flow that previously drained elsewhere. This
 * includes plants such as nether sprouts, which vanish with their support.
 * Liquid below cannot flow upward. Mining preparation and excavation footing
 * checks separately prevent dropping a dry miner through an aquifer roof.
 */
function opensIntoLiquid(world: WorldView, x: number, y: number, z: number): boolean {
  const above = world.blockAt(x, y + 1, z);
  if (above.kind === "loaded" && above.traits.liquid !== null) return true;

  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (above.kind === "loaded" && above.traits.empty && liquidAt(world, x + dx, y + 1, z + dz)) return true;
    const adjacent = liquidAt(world, x + dx, y, z + dz);
    if (adjacent === null) continue;
    if (adjacent === "source") return true;
    if (liquidAt(world, x + dx, y - 1, z + dz) === null) return true;
  }
  return false;
}

function dryGroundedDigTime(bot: Bot, block: WorldBlock, item: InventoryItem | null): number {
  return block.digTime(
    item?.type ?? null,
    bot.game.gameMode === "creative",
    false,
    false,
    enchantmentsOf(bot, item),
    Object.values(bot.entity.effects ?? {}),
  );
}

/** Select the carried item that Mineflayer says breaks this block fastest. */
export function selectHarvestTool(bot: Bot, block: WorldBlock): InventoryItem | null {
  let best: InventoryItem | null = null;
  let fastest = dryGroundedDigTime(bot, block, null);
  for (const item of bot.inventory.items()) {
    const milliseconds = dryGroundedDigTime(bot, block, item);
    if (milliseconds >= fastest) continue;
    fastest = milliseconds;
    best = item;
  }
  return best;
}

function toolSelection(bot: Bot, block: WorldBlock, tool: InventoryItem | null): ToolSelection {
  return {
    itemType: tool?.type ?? null,
    expectedTicks: Math.max(1, dryGroundedDigTime(bot, block, tool) / 50),
  };
}

/** What breaking one block state costs with the current inventory, independent of where it sits. */
interface BreakPlan {
  readonly blockType: number;
  readonly harvestable: boolean;
  readonly requiresExplicitRemoval: boolean;
  readonly tool: ToolSelection;
}

/**
 * Break plans per block state, forgotten whenever the inventory or the bot's
 * status effects change, since both move the fastest tool and its dig time.
 *
 * Search asks about every solid cell a movement could dig through, so this
 * lookup runs thousands of times per search; choosing a tool means a dig-time
 * calculation per carried item, which is far too much to repeat per cell.
 *
 * One cache per bot, not per policy. A policy is made for every route, and a
 * fight or a pickup makes several a minute; a cache with its own listeners
 * on each of them left the inventory with a listener per route ever run.
 */
const breakPlans = new WeakMap<Bot, BreakPlans>();

interface BreakPlans {
  readonly known: Map<number, BreakPlan>;
  /** Counts the times the plans were forgotten, so a table built on them knows when it has gone stale. */
  version: number;
}

interface BreakPlanner {
  plan(stateId: number): BreakPlan;
  readonly version: number;
}

function breakPlanner(bot: Bot): BreakPlanner {
  const Block = blockClass(bot);
  let plans = breakPlans.get(bot);
  if (!plans) {
    const cache: BreakPlans = { known: new Map<number, BreakPlan>(), version: 0 };
    const forget = () => {
      cache.known.clear();
      cache.version += 1;
    };
    const forgetOwnEffect = (entity: { id: number }) => {
      if (entity.id === bot.entity.id) forget();
    };
    bot.inventory.on("updateSlot", forget);
    bot.on("entityEffect", forgetOwnEffect);
    bot.on("entityEffectEnd", forgetOwnEffect);
    breakPlans.set(bot, cache);
    plans = cache;
  }
  const cache = plans;
  return {
    plan(stateId) {
      let plan = cache.known.get(stateId);
      if (!plan) {
        const block = Block.fromStateId(stateId, 0);
        const tool = selectHarvestTool(bot, block);
        plan = {
          blockType: block.type,
          // Unlike ordinary terrain, a spawner cannot be recovered by mining.
          // Travel through the fortress destroyed the source of later hunts.
          // Explicit excavation remains available through isRequestedBreak.
          requiresExplicitRemoval: block.name === "spawner",
          harvestable: block.canHarvest(tool?.type ?? null),
          tool: toolSelection(bot, block, tool),
        };
        cache.known.set(stateId, plan);
      }
      return plan;
    },
    get version() {
      return cache.version;
    },
  };
}

/**
 * One answer per block state, kept beside the observation it was made from.
 *
 * Search asks the policy about the same few dozen states tens of thousands
 * of times per route, and most of every answer depends on the state alone,
 * so it is settled once per state, the way Baritone's `PrecomputedData`
 * settles a block state's walkability. A state's observation is one shared
 * object in production, so recognising it is a pointer compare; a test that
 * hands in an observation of its own is answered afresh, not from the table.
 */
class StateTable<T> {
  readonly #blocks: (LoadedBlock | undefined)[];
  readonly #answers: (T | undefined)[];

  constructor(states: number) {
    this.#blocks = new Array<LoadedBlock | undefined>(states).fill(undefined);
    this.#answers = new Array<T | undefined>(states).fill(undefined);
  }

  lookup(block: LoadedBlock): T | undefined {
    return this.#blocks[block.stateId] === block ? this.#answers[block.stateId] : undefined;
  }

  remember(block: LoadedBlock, answer: T): T {
    this.#blocks[block.stateId] = block;
    this.#answers[block.stateId] = answer;
    return answer;
  }

  clear(): void {
    this.#blocks.fill(undefined);
    this.#answers.fill(undefined);
  }
}

/** How many block states the registry names: the size of a table indexed by state id. */
function stateCount(registry: Bot["registry"]): number {
  let highest = 0;
  for (const block of registry.blocksArray) if (block.maxStateId > highest) highest = block.maxStateId;
  return highest + 1;
}

function scaffoldSelection(bot: Bot, protectedNames: ReadonlySet<string>, enabled: boolean): ScaffoldSelection | null {
  if (!enabled) return null;
  const item = preferredScaffoldItem(bot, protectedNames);
  if (!item) return null;
  const block = bot.registry.blocksByName[item.name]!;
  if (!block.states?.some((state) => state.name === "axis"))
    return { itemType: item.type, stateId: block.defaultState };
  const Block = blockClass(bot);
  const stateFor = (axis: string) => Block.fromProperties(block.id, { axis }, 0).stateId;
  return {
    itemType: item.type,
    stateId: block.defaultState,
    stateIdByAxis: { x: stateFor("x"), y: stateFor("y"), z: stateFor("z") },
  };
}

/** Build the movement policy used by production and scenarios; only its scaffold choice is live. */
/**
 * What breaking one block costs a route beyond the ticks spent digging it.
 *
 * Baritone's `blockBreakAdditionalPenalty` is two, which in its cost units is
 * about half a block of sprinting — enough to break a tie and nothing more.
 * That suits a client whose whole purpose is mining. A bot asked to walk
 * somewhere is not mining, and at two it will happily open a hole in a wall to
 * save a corner: it left a house through its back wall rather than the door
 * beside it, and tunnelled through a cliff rather than climbing it. Six blocks
 * of walking per block destroyed keeps the shortcut available where it saves
 * real distance and refuses it where it only saves a few steps.
 *
 * Actions whose purpose is to change terrain say so by passing their own.
 */
export const TERRAIN_BREAK_PENALTY = 25;

/**
 * The fall a route takes unassisted, in blocks: three costs no health.
 *
 * Anything longer is a bucket drop, and `MAXIMUM_BUCKET_DROP` is how far one
 * of those may go. Both are quoted to the model by `view_status`, so a bot
 * with no water bucket is told why its routes stop descending at three.
 */
export const DEFAULT_MAXIMUM_DROP = 3;

/** The longest planned water-bucket drop, matching the survival policy's own description of `bucket_drops`. */
export const MAXIMUM_BUCKET_DROP = 80;

/** The step decisions, shared: search asks about every cell it could stand in, and the answer names no cell. */
const ALLOWED_STEP: PolicyDecision = { kind: "allowed" };
const AVOIDED_STEP: PolicyDecision = { kind: "prohibited", reason: "movement policy avoids this block" };
const OPENS_INTO_LIQUID: PolicyDecision = {
  kind: "prohibited",
  cause: "opens_into_liquid",
  reason: BREAK_OPENS_INTO_LIQUID,
};
const AVOIDED_BITS = TRAIT_DAMAGING | TRAIT_LAVA;

export function createMineflayerMovementPolicy(
  bot: Bot,
  options: MineflayerMovementPolicyOptions = {},
): MovementPolicy {
  const allowDoors = options.allowDoors ?? true;
  const allowParkour = options.allowParkour ?? true;
  const protectedBlockIds = new Set(
    [...ROUTE_PROTECTED_CROPS, ...(options.protectedBlockNames ?? [])].flatMap((name) => {
      const block = bot.registry.blocksByName[name];
      return block ? [block.id] : [];
    }),
  );
  // Search asks about every cell a route could stand in, so the blocks to
  // avoid are known by state id, which is what an observation carries.
  const states = stateCount(bot.registry);
  const avoidedStates = new Uint8Array(states);
  for (const name of AVOID_BLOCKS) {
    const block = bot.registry.blocksByName[name];
    if (!block) continue;
    for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) avoidedStates[stateId] = 1;
  }
  const scaffolding = options.scaffolding ?? true;
  const protectedScaffolds = new Set(options.protectedScaffoldNames ?? []);
  const planner = breakPlanner(bot);
  // The refusals name no cell, so each is one shared evaluation.
  const unavailable = (reason: string): BreakEvaluation => ({
    decision: { kind: "prohibited", reason },
    tool: { itemType: null, expectedTicks: 20 },
  });
  const unloaded = unavailable("movement policy cannot break an unloaded block");
  const prohibited = unavailable("movement policy prohibits breaking this block");
  const unharvestable = unavailable("no carried tool can harvest this block");
  const terrainBreak: PolicyDecision = {
    kind: "penalized",
    reason: "prefer a route that preserves terrain",
    cost: options.breakPenalty ?? TERRAIN_BREAK_PENALTY,
  };
  /** A break the calling task must have asked for by cell: a container, a door, a sign. */
  const needsRequest = (observation: LoadedBlock, plan: BreakPlan) =>
    plan.requiresExplicitRemoval || observation.traits.interactive || (allowDoors && observation.traits.openable);

  // What breaking a state costs before its cell is known: prohibited outright,
  // breakable with the plan's tool and the terrain penalty, or breakable but
  // not with anything carried. Forgotten with the tool plans it is built on.
  const breakByState = new StateTable<BreakEvaluation>(states);
  let breakTableVersion = planner.version;
  const stateBreak = (observation: LoadedBlock): BreakEvaluation => {
    if (planner.version !== breakTableVersion) {
      breakByState.clear();
      breakTableVersion = planner.version;
    }
    const known = breakByState.lookup(observation);
    if (known !== undefined) return known;
    const plan = planner.plan(observation.stateId);
    if (
      !observation.traits.safeToBreak ||
      (needsRequest(observation, plan) && !options.isRequestedBreak) ||
      protectedBlockIds.has(plan.blockType)
    ) {
      return breakByState.remember(observation, prohibited);
    }
    if (options.requireHarvestTool && !plan.harvestable) return breakByState.remember(observation, unharvestable);
    return breakByState.remember(observation, { decision: terrainBreak, tool: plan.tool });
  };

  /** A break refused by the cell it is in: not requested where a request is needed, or a cell the caller protects. */
  const refusedAtCell = (observation: LoadedBlock, position: BlockPosition): boolean =>
    (options.isRequestedBreak !== undefined &&
      needsRequest(observation, planner.plan(observation.stateId)) &&
      !options.isRequestedBreak(observation, position)) ||
    (options.protectedCells?.has(packKey(position.x, position.y, position.z)) ?? false);

  // Whether a route may stand in or on a cell: damaging, lava, or a block to
  // avoid. Search asks this of every arrival, so it is the observation's
  // bits and one table read.
  const avoids = (observation: BlockObservation): boolean =>
    (observation.bits & AVOIDED_BITS) !== 0 ||
    (observation.kind === "loaded" && avoidedStates[observation.stateId] === 1);

  const policy = createMovementPolicy({
    allowDigging: options.allowDigging ?? true,
    allowPlacing: scaffolding,
    allowDoors,
    allowParkour,
    allowDiagonalAscend: options.allowDiagonalAscend ?? true,
    allowSprinting: options.allowSprinting ?? true,
    maximumDrop: options.maximumDrop ?? DEFAULT_MAXIMUM_DROP,
    placementPenalty: options.placementPenalty ?? 20,
    priceBreak: (observation) => (observation.kind === "unloaded" ? unloaded : stateBreak(observation)),
    confirmBreak: (observation, position, world) => {
      if (observation.kind === "unloaded") return unloaded.decision;
      if (refusedAtCell(observation, position)) return prohibited.decision;
      return opensIntoLiquid(world, position.x, position.y, position.z) ? OPENS_INTO_LIQUID : ALLOWED_STEP;
    },
    evaluateBreak: (observation, position, world) => {
      if (observation.kind === "unloaded") return unloaded;
      const verdict = stateBreak(observation);
      if (verdict === prohibited) return verdict;
      // The rules that need the cell, in the order the reasons were always
      // given: a requested break is judged by cell, and a protected cell
      // refuses before the tool is questioned.
      if (refusedAtCell(observation, position)) return prohibited;
      if (verdict === unharvestable) return verdict;
      // Last, and with the tool it would have used: a caller that owns the
      // target break needs to know this refusal is the flood rule rather than
      // an unbreakable block, and it needs the pickaxe the break will take.
      if (opensIntoLiquid(world, position.x, position.y, position.z)) {
        return { decision: OPENS_INTO_LIQUID, tool: verdict.tool };
      }
      return verdict;
    },
    decidePlace: (x, y, z) => {
      // The route moves our own body before placing; other bodies are live obstacles.
      const reason = occupiedCell(bot, { x, y, z }, bot.entity.id);
      return reason ? { kind: "prohibited", reason } : ALLOWED_STEP;
    },
    decideStep: (x, y, z, world) => {
      // The cell itself and the one it stands on.
      for (let dy = 0; dy >= -1; dy -= 1) {
        const observation = world.blockAt(x, y + dy, z);
        if (avoids(observation)) return AVOIDED_STEP;
      }
      return ALLOWED_STEP;
    },
  });
  // Chosen when read, not when the policy is made. A run reads it once per
  // search, so one route places one block; a route that spends a whole stack
  // then replans onto the next carried stack. Chosen once, a bridge across a
  // lava sea ended on the last netherrack with sixteen cobblestone unused.
  return Object.freeze({
    ...policy,
    get maximumBucketDrop() {
      return readNavigationPolicy(bot).bucket_drops && bucketAvailable(bot) ? MAXIMUM_BUCKET_DROP : 0;
    },
    get scaffold() {
      return scaffoldSelection(bot, protectedScaffolds, scaffolding);
    },
  });
}
