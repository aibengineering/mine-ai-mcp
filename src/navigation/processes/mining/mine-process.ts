/**
 * Mine matching blocks until the caller's inventory quantity is satisfied.
 * The target set is one continuously revalidated composite goal: excavation
 * goals price the work remaining at each stance, and drop goals recover the
 * items that work leaves behind. Search owns approach and dig selection;
 * this process owns quantities, target observation, and lava preparation.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, cellKey } from "../../../utils/index.js";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../../world/block-visibility.js";
import { droppedItemName } from "../../../world/item-pickup.js";
import type { useItemAt } from "../../../world/item-use.js";
import { isLiquidSource, sourceInSight, USE_RAY_REACH } from "../../../world/liquid.js";
import { findLoadedBlockPositions } from "../../../world/loaded-block-scan.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import { excavateGoal } from "../../goals/excavate.js";
import {
  anyGoal,
  describeCalculationFailure,
  exactBlockGoal,
  itemPickupGoal,
  nearGoal,
  occupyGoal,
  type BlockPosition,
  type BreakBlockInPlace,
  type Goal,
  type MovementPolicy,
  type Navigate,
  type NavigationResult,
} from "../../index.js";
import { observeMineflayerBlock } from "../../mineflayer/world.js";
import { UNLOADED } from "../../world/world.js";
import { isSafeSupport } from "../../world/block-geometry.js";
import { admitsDive, openWaterSurface } from "../../world/swimming.js";
import { holdWaterPosition } from "../../steering/hold-water-position.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { DIG_REACH } from "../../movements/excavation.js";
import { branchMiningGoal } from "./block-exploration.js";
import { carriesWaterBucket, CAST_REACH, castOntoPool } from "./cast-obsidian.js";
import { CastTargets } from "./cast-targets.js";
import { DROP_PICKUP_TIMEOUT_MS, MineDropTracker } from "./mine-drops.js";
import { clearMiningWater } from "./mining-water.js";
import { waterMiningStance } from "../../world/water.js";
import { lavaFacesOf, type MineTargetDecision } from "./target-safety.js";

/** A loaded Mineflayer block, which is what `matches` is asked about. */
export type MinecraftBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

/**
 * How many locations the composite goal may hold, matching Baritone's
 * `maxOreLocationsToConsider`.
 */
export const MAX_MINE_TARGETS = 64;

/**
 * How often the goal actually looks at the world again.
 *
 * The planner asks for a snapshot far more often than the world changes, and a
 * scan is 256 block reads. Baritone throttles the same rescan with
 * `mineGoalUpdateInterval`, five ticks. Between refreshes the cached target set
 * is returned unchanged, which also keeps the goal's revision stable so the
 * planner is not told the goal moved when it did not.
 */
const GOAL_UPDATE_MS = 250;
/**
 * Stopped routes in a row, with nothing broken or gained between them, before
 * mining settles as stopped. Each stop already gives up one target, but a
 * lava pool casts a fresh obsidian target for every one given up, and a bot
 * pinned in its own poured water stopped forty such routes in a row.
 */
const MAX_FRUITLESS_STOPS = 5;

/**
 * How many of a pool's sources its goal offers as lips to stand beside. The
 * search prices every branch of a composite goal at every node, and the
 * sources are nearest-first, so a lake of two hundred cells would put its
 * whole surface on the hot path to describe the same near edge.
 */
const POOL_GOAL_LIPS = 8;

function targetInSight(bot: Bot, eye: Vec3, position: BlockPosition): boolean {
  const block = bot.blockAt(asVec3(position));
  return (
    block !== null &&
    visibleBlockAim(bot.world, eye, position, DIG_REACH, observeMineflayerBlock(block).collisionShapes) !== null
  );
}

/** A loaded matching block is owned by its world cell. */
export interface MineBlockTarget {
  readonly position: BlockPosition;
  readonly kind: "block";
  /**
   * Whether a route may break this cell on its way into it. False when liquid
   * touches it: the flood rule refuses such a break in passing, so the process
   * walks into reach, closes the lava faces, and breaks it in place.
   */
  readonly routeMayBreak: boolean;
  readonly excludedStances: ReadonlySet<string>;
}

/** A live Mineflayer item remains the same target while its position changes. */
export interface MineDropTarget {
  readonly position: BlockPosition;
  readonly kind: "drop";
  readonly entityId: number;
}

/** A broken source bridges the packet interval before its item entity exists. */
export interface MineAnticipatedDropTarget {
  readonly position: BlockPosition;
  readonly kind: "anticipated_drop";
}

/** An observed item vanished while Mineflayer is still applying its pickup. */
export interface MineSettlingDropTarget {
  readonly position: BlockPosition;
  readonly kind: "settling_drop";
  readonly entityId: number;
}

/**
 * A lava pool the request can cast into, held at its nearest source.
 *
 * Obsidian is the one block a bot manufactures rather than finds, so when a
 * cast request has nothing to mine the lava becomes a target like any other:
 * the route walks to it, the loop pours where it arrives, and the obsidian
 * that forms is an ordinary block target for the next pass.
 */
export interface MinePoolTarget {
  readonly position: BlockPosition;
  readonly kind: "pool";
  readonly sources: readonly BlockPosition[];
  readonly excludedStances: ReadonlySet<string>;
}

/** Water left by a cast must return to its bucket before mining resumes. */
export interface MineWaterTarget {
  readonly kind: "water";
  readonly position: BlockPosition;
  readonly excludedStances: ReadonlySet<string>;
}

type WaterRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "casting" }
  | { readonly kind: "pending"; readonly target: MineWaterTarget }
  | { readonly kind: "failed"; readonly reason: string };

/** One thing worth standing at: a block to break, an item to walk over, or a pool to pour on. */
export type MineTarget =
  | MineBlockTarget
  | MineDropTarget
  | MineAnticipatedDropTarget
  | MineSettlingDropTarget
  | MinePoolTarget
  | MineWaterTarget;

export interface MineRequest {
  /** Deliberate discards are excluded from both scans and anticipated drops. */
  readonly ignoredDropIds?: ReadonlySet<number>;
  /** Which blocks count as ore. */
  readonly matches: (block: MinecraftBlock) => boolean;
  /**
   * Whether this loaded target can come out, and what must happen first.
   * `target-safety.ts` holds the rule; the caller supplies its policy and world.
   */
  readonly canMine: (block: MinecraftBlock) => MineTargetDecision;
  /** Every raw block-state ID accepted by `matches`. */
  readonly matchingStateIds: ReadonlySet<number>;
  /**
   * Optional exact loaded cell. Kept separate because Mineflayer also calls
   * `matches` on palette blocks with null positions.
   */
  readonly exactTarget?: BlockPosition;
  /** Which dropped item names are worth walking to. */
  readonly collects: (itemName: string) => boolean;
  /**
   * Whether the caller has what it asked for. Baritone's `MineProcess` counts
   * matching items in the inventory itself; ours asks, because what counts as a
   * gain depends on loot tables and silk touch that belong with the caller.
   */
  readonly isSatisfied: () => boolean;
  /** Inventory gain already observed for this collection request. */
  readonly observedInventoryGain: () => number;
  readonly movements: MovementPolicy;
  /** Radius for finding lava pools to cast when no matching block is loaded. */
  readonly castSearchRadius: number;
  /** Search outward from the first empty scan until a loaded column reveals a target. */
  readonly explore: boolean;
  /** A bound on mining for a quantity that never arrives. */
  readonly maximumBreaks: number;
  readonly signal?: AbortSignal;
  /** A policy stop observed between completed digs/routes, preserving safe settlement. */
  readonly stopSignal?: AbortSignal;
  /** Observers of the target set, called when it changes. */
  readonly onTargets?: (targets: readonly MineTarget[]) => void | Promise<void>;
  /** Preserve observed matching-block removals even when this attempt is cancelled. */
  readonly onBroken?: (position: BlockPosition) => void;
  /** Injectable physical effect for process regressions. */
  readonly breakInPlace: BreakBlockInPlace;
  /** Injectable physical placement: how a lava face is closed before a target break. */
  readonly placeInto: PlaceIntoCell;
  /**
   * How the bot uses its water bucket to cast this request's block out of a
   * lava source, or null when the block cannot be made that way — which is
   * every block but obsidian. With it, a run that finds no target and does
   * find lava makes its own targets rather than reporting none.
   */
  readonly cast: typeof useItemAt | null;
  /**
   * Route execution, injectable so the process can be exercised without a
   * server. Every bug this loop has had was in how it reacts to a route's
   * outcome, which is a question a fake can answer in a millisecond.
   */
  readonly route: Navigate;
}

export type MineResult = {
  readonly status: "satisfied" | "no_targets" | "unreachable" | "exhausted" | "stopped";
  /** Cells of matching blocks that stopped matching while this process was running, in the order observed. */
  readonly broken: readonly BlockPosition[];
  readonly reason: string | null;
};

function targetIdentity(target: MineTarget): string {
  switch (target.kind) {
    case "block":
      return `block:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
    case "drop":
      return `drop:${target.entityId}`;
    case "anticipated_drop":
      return `anticipated:${cellKey(target.position)}`;
    case "settling_drop":
      return `settling:${target.entityId}`;
    case "water":
      return `water:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
    case "pool":
      return `pool:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
  }
}

function isDropTarget(
  target: MineTarget,
): target is MineDropTarget | MineAnticipatedDropTarget | MineSettlingDropTarget {
  return target.kind === "drop" || target.kind === "anticipated_drop" || target.kind === "settling_drop";
}

/**
 * Adjacent working cells with dry headroom or a budgeted, supported open-water dive.
 * The goal and the physical dig use the same cells. A stance found occluded
 * after arrival is excluded so the route can select another approach.
 */
function workingCells(bot: Bot, target: MineBlockTarget, movements: MovementPolicy): readonly BlockPosition[] {
  const position = target.position;
  const read = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block ? observeMineflayerBlock(block) : UNLOADED;
  };
  return [
    { x: position.x + 1, y: position.y - 1, z: position.z },
    { x: position.x - 1, y: position.y - 1, z: position.z },
    { x: position.x, y: position.y - 1, z: position.z + 1 },
    { x: position.x, y: position.y - 1, z: position.z - 1 },
    { x: position.x + 1, y: position.y, z: position.z },
    { x: position.x - 1, y: position.y, z: position.z },
    { x: position.x, y: position.y, z: position.z + 1 },
    { x: position.x, y: position.y, z: position.z - 1 },
    { x: position.x, y: position.y + 1, z: position.z },
    { x: position.x + 1, y: position.y + 1, z: position.z },
    { x: position.x - 1, y: position.y + 1, z: position.z },
    { x: position.x, y: position.y + 1, z: position.z + 1 },
    { x: position.x, y: position.y + 1, z: position.z - 1 },
  ].filter((cell) => {
    // Obsidian takes longer than a breath when the eye is submerged. A pickup
    // may dip into its hole; the next mining stance must return to the surface.
    const head = bot.blockAt(new Vec3(cell.x, cell.y + 1, cell.z));
    if (!head || target.excludedStances.has(cellKey(cell))) return false;
    if (head.name !== "water") return true;
    if (!movements.allowSwimming || !isSafeSupport(read(cell.x, cell.y - 1, cell.z))) return false;
    const surface = openWaterSurface(read, cell);
    if (!surface) return false;
    const block = read(position.x, position.y, position.z);
    const tool = movements.evaluateBreak(block, position, { blockAt: read, revision: 0, subscribe: () => () => {} }).tool;
    const work = movements.digTimeEstimator.estimate(block, tool, {
      submergedAtEyes: true, onGround: true, aquaAffinity: false, effects: {},
    });
    // Filter impossible work at full air. The runtime checks current air before the actual dig.
    return admitsDive(read, cell, { origin: surface, airTicks: 300 }, work + 20);
  });
}

/**
 * Matching blocks and collectable items within range, nearest first.
 *
 * Baritone's `prune` drops duplicates, blacklisted cells, cells that no longer
 * match, and anything implausible to break, then sorts by distance and caps the
 * list. The raw scan is already nearest-first, so only candidates retained for
 * the composite goal need to become Mineflayer's richer block objects.
 */
interface MineScan {
  readonly targets: readonly MineTarget[];
  /** How many loaded matching blocks were rejected, by the reason each was rejected for. */
  readonly rejections: ReadonlyMap<string, number>;
}

function rejectionSummary(rejections: ReadonlyMap<string, number>): string {
  const total = [...rejections.values()].reduce((sum, count) => sum + count, 0);
  const detail = [...rejections.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => (count === 1 ? reason : `${reason} (×${count})`))
    .join("; ");
  return `${total} loaded matching block(s) cannot be mined: ${detail}`;
}

interface MineBlacklist {
  readonly blockCells: ReadonlySet<string>;
  readonly blockStances: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dropEntities: ReadonlySet<number>;
}

function scan(bot: Bot, request: MineRequest, blacklist: MineBlacklist): MineScan {
  const feet = bot.entity?.position ?? new Vec3(0, 64, 0);
  // A named cell must not disappear behind the general scan's nearest matches.
  // Otherwise consider every loaded match, as the public block view does:
  // a known target outside a local radius is still a target, not a reason to explore.
  const positions = request.exactTarget
    ? [request.exactTarget]
    : findLoadedBlockPositions(bot, {
        center: feet,
        stateIds: request.matchingStateIds,
        limit: 256,
      });
  const blocks: MineBlockTarget[] = [];
  const rejections = new Map<string, number>();
  for (const position of positions) {
    const key = cellKey(position);
    if (blacklist.blockCells.has(key)) continue;
    const block = bot.blockAt(asVec3(position));
    if (block === null || !request.matches(block)) continue;
    const decision = request.canMine(block);
    if (decision.kind !== "mineable") {
      rejections.set(decision.reason, (rejections.get(decision.reason) ?? 0) + 1);
      continue;
    }
    blocks.push({
      position: block.position,
      kind: "block",
      routeMayBreak: decision.routeMayBreak,
      excludedStances: blacklist.blockStances.get(key) ?? new Set(),
    });
    if (blocks.length === MAX_MINE_TARGETS) break;
  }

  const drops = Object.values(bot.entities ?? {})
    .filter((entity) => {
      const name = droppedItemName(entity);
      return name !== null && request.collects(name);
    })
    .filter((entity) => !blacklist.dropEntities.has(entity.id) && !request.ignoredDropIds?.has(entity.id))
    .map((entity) => ({ position: entity.position.floored(), kind: "drop" as const, entityId: entity.id }));

  const seen = new Set<string>();
  const targets = [...drops, ...blocks]
    .filter((target) => {
      const identity = targetIdentity(target);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((left, right) => feet.distanceSquared(asVec3(left.position)) - feet.distanceSquared(asVec3(right.position)))
    .slice(0, MAX_MINE_TARGETS);
  return { targets, rejections };
}

/** Cast from above the source, after climbing out of any preceding mining hole. */
function castStance(target: MinePoolTarget, feet: BlockPosition): boolean {
  return (
    !target.excludedStances.has(cellKey(feet)) &&
    target.sources
      .slice(0, POOL_GOAL_LIPS)
      .some((source) => feet.y > source.y && asVec3(feet).distanceTo(asVec3(source)) <= CAST_REACH)
  );
}

function waterStance(bot: Bot, target: MineWaterTarget, feet: BlockPosition): boolean {
  return (
    !target.excludedStances.has(cellKey(feet)) &&
    sourceInSight(bot, new Vec3(feet.x + 0.5, feet.y + STANDING_EYE_HEIGHT, feet.z + 0.5), asVec3(target.position))
  );
}

/** The work or arrival represented by one live target. */
function coalesce(bot: Bot, target: MineTarget, movements: MovementPolicy): Goal {
  if (target.kind === "drop") return itemPickupGoal({ id: target.entityId });
  if (target.kind === "anticipated_drop" || target.kind === "settling_drop") return occupyGoal(target.position, 2);
  if (target.kind === "water") {
    const approach = nearGoal(target.position, USE_RAY_REACH + STANDING_EYE_HEIGHT);
    return {
      resolve(observation) {
        const goal = approach.resolve(observation);
        if (goal.kind !== "active") return goal;
        return {
          ...goal,
          revision: targetIdentity(target),
          isSatisfied: (node) => waterStance(bot, target, node.feet),
        };
      },
    };
  }
  // A pool is poured on from beside it, and every source of it will do, so the
  // route takes the cheapest lip rather than the one nearest the scan.
  if (target.kind === "pool") {
    const approach = anyGoal(target.sources.slice(0, POOL_GOAL_LIPS).map((source) => nearGoal(source, CAST_REACH)));
    return {
      resolve(observation) {
        const goal = approach.resolve(observation);
        if (goal.kind !== "active") return goal;
        return {
          ...goal,
          revision: targetIdentity(target),
          isSatisfied: (node) => castStance(target, node.feet),
        };
      },
    };
  }
  // A target the route may not break cannot be reached by standing in it: the
  // flood rule refuses the break that would clear the way. Stand in a cell
  // that touches it and let the loop seal it and break it from there.
  if (!target.routeMayBreak) return anyGoal(workingCells(bot, target, movements).map(exactBlockGoal));
  return excavateGoal(target.position);
}

/**
 * Close every lava cell touching the target with a carried block, from where
 * the bot stands, and say why if one of them would not close.
 *
 * The count is taken here, over the six neighbours, from the live world after
 * the route has ended — not from the scan that chose the target, which may be
 * seconds and several blocks stale. A face missed by the count floods the
 * mined cell, which is the one way this whole design goes wrong.
 */
async function sealLavaFaces(
  bot: Bot,
  request: MineRequest,
  position: BlockPosition,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const face of lavaFacesOf(bot, position)) {
    const placed = await request.placeInto(bot, face, { ...(signal && { signal }) });
    if (placed.kind === "failed") {
      return `the lava at ${cellKey(face)} could not be closed: ${placed.error}`;
    }
  }
  return null;
}

async function breakTargetInPlace(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  target: MineTarget,
  signal?: AbortSignal,
): Promise<void> {
  const workingFeet = bot.entity.position.floored();
  const water = await clearMiningWater(bot, target.position, request.placeInto, request.cast, signal);
  if (water !== null) {
    // Preparation can move the bot in a current. Reject the stance we tried,
    // not the lower cell it sank into while the water was being isolated.
    if (target.kind === "block") targeting.excludeBlockStance(target, workingFeet);
    targeting.lastReason = water;
    return;
  }
  const seal = await sealLavaFaces(bot, request, target.position, signal);
  if (seal !== null) {
    targeting.blacklist(target, seal);
    return;
  }
  const swing = await request.breakInPlace({ movements: request.movements, position: target.position, signal });
  if (swing.status === "failed") {
    targeting.blacklist(target, swing.reason);
    return;
  }
  targeting.refresh();
  await targeting.announce();
}

/**
 * Targets whose break the route refuses, or work attempted from a current:
 * prepare one and break it where the bot stands. A block with liquid against it comes out here —
 * a route that could clear the way to it would have to open that liquid into
 * its own path first.
 *
 * Exactly one per pass, unlike the shaft, because these are broken from beside
 * rather than from inside and their drops stay where the block was: the lake
 * fixture spent its whole break allowance on a burst of six and walked home
 * with four obsidian while ten lay on the ground.
 */
async function sealAndBreakInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  // Working cells may be reached by swimming. The physical dig owns water
  // positioning and its slower dig time; requiring ground here leaves that
  // already-satisfied goal repeatedly arriving without ever starting the dig.
  if ((!bot.entity.onGround && Reflect.get(bot.entity, "isInWater") !== true) || targeting.isSatisfied()) return false;
  if (targeting.broken.length >= request.maximumBreaks) return false;
  // Collect what the last one of these left on the ground first.
  if (targeting.targets().some(isDropTarget)) return false;
  const feet = bot.entity.position.floored();
  const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
  const currentNeedsPreparation = bot.blockAt(feet)?.name === "water" &&
    !waterMiningStance((x, y, z) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      return block ? observeMineflayerBlock(block) : UNLOADED;
    }, feet, bot.entity.onGround);
  const target = targeting
    .targets()
    .find(
      (candidate) =>
        candidate.kind === "block" &&
        (!candidate.routeMayBreak || currentNeedsPreparation) &&
        workingCells(bot, candidate, request.movements).some((cell) => cellKey(cell) === cellKey(feet)) &&
        targetInSight(bot, eye, candidate.position),
    );
  if (!target) return false;
  // A goal can become satisfied during a speculative search as the swimmer
  // enters this cell. Mining needs the actual floor, not the floored Y alone.
  if (!bot.entity.onGround && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "water") {
    const release = holdWaterPosition(bot, signal, (control, active) =>
      bot.setControlState(control, control === "jump" ? false : active));
    try {
      for (let tick = 0; tick < 60 && !bot.entity.onGround; tick++)
        await waitForPhysicsTicks(bot, 1, signal ?? new AbortController().signal);
    } finally { release(); }
    if (!bot.entity.onGround) return false;
  }
  await breakTargetInPlace(bot, request, targeting, target, signal);
  return true;
}

/**
 * Pools the bot is standing beside: pour, and let the rescan mine what formed.
 *
 * This is the cast, and it sits here rather than in a branch of its own
 * because it is the same shape as the seal — a target the route walked to that
 * has to be worked where the bot stands. A pour that made no obsidian gives up
 * on the pool and says so; one that made some is left alone, so a lake can be
 * poured again when the first ring is not enough.
 */
async function castInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const useItem = request.cast;
  if (useItem === null || bot.entity.onGround !== true || targeting.isSatisfied()) return false;
  const feet = bot.entity.position.floored();
  const target = targeting.targets().find((candidate) => candidate.kind === "pool" && castStance(candidate, feet));
  if (target?.kind !== "pool") return false;

  const physics = {
    useItem,
    breakInPlace: request.breakInPlace,
    movements: request.movements,
    ...(signal && { signal }),
  };
  targeting.beginCast();
  let outcome;
  try {
    outcome = await castOntoPool(bot, physics, target.sources);
  } finally {
    targeting.endCast();
  }
  if (outcome.kind === "reposition") {
    targeting.excludeCastStance(target, feet, outcome.reason);
    return true;
  }
  if (outcome.kind === "failed") {
    targeting.blacklist(target, `the lava at ${cellKey(target.position)} could not be cast: ${outcome.reason}`);
    return true;
  }
  if (outcome.obsidianFormed === 0) {
    targeting.blacklist(target, `the pour into ${cellKey(outcome.landing)} formed no obsidian`);
  }
  if (!outcome.waterRecovered) targeting.recoverWater(outcome.landing);
  targeting.refresh();
  await targeting.announce();
  return true;
}

/** Re-approach the known source when the original pour ray can no longer scoop it. */
async function recoverWaterInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  const target = targeting.targets().find((candidate) => candidate.kind === "water");
  if (target?.kind !== "water" || request.cast === null) return false;
  const feet = bot.entity.position.floored();
  if (
    !waterStance(bot, target, feet) ||
    !sourceInSight(bot, bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0), asVec3(target.position))
  )
    return false;
  const bucket = bot.inventory.items().find((item) => item.name === "bucket");
  if (!bucket) {
    targeting.blacklist(target, "the cast water remains in the world, but no empty bucket is carried");
    return true;
  }
  const outcome = await request.cast(bot, {
    item: bucket,
    lookAt: asVec3(target.position).offset(0.5, 0.9, 0.5),
    expectedHeldItem: "water_bucket",
    ...(signal && { signal }),
  });
  if (outcome.kind === "failed") targeting.excludeWaterStance(target, feet, outcome.error);
  targeting.refresh();
  await targeting.announce();
  return true;
}

/**
 * Everything one mining run remembers between looks at the world.
 *
 * It is shared by the loop and the goal because they are asking the same
 * question at different rates: the goal on every planner snapshot, the loop
 * once a route has ended. Keeping one cache means they can never disagree about
 * what the targets are.
 */
class MineTargeting {
  #water: WaterRecovery = { kind: "none" };
  readonly #blockBlacklist = new Set<string>();
  readonly #blockStances = new Map<string, ReadonlySet<string>>();
  readonly #casts: CastTargets;
  readonly #dropBlacklist = new Set<number>();
  readonly #anticipatedDropBlacklist = new Set<string>();
  readonly #drops: MineDropTracker;
  #targets: readonly MineTarget[] = [];
  #goal: Goal | null = null;
  #branchGoal: Goal | null = null;
  #branchFailure: string | null = null;
  #knownBlocks: readonly BlockPosition[] = [];
  #refreshedAtMs = Number.NEGATIVE_INFINITY;
  #announced = "";
  /** Why each loaded matching block the last scan saw could not be a target, and how many were rejected for it. */
  rejections: ReadonlyMap<string, number> = new Map();
  readonly broken: BlockPosition[] = [];
  lastReason: string | null = null;
  /** Whether a just-broken source is still awaiting its item entity. */
  get anticipatingDrop(): boolean {
    return this.#drops.anticipating;
  }

  dropInFlight(entityId: number): boolean {
    return this.#drops.inFlight(entityId);
  }

  constructor(
    private readonly bot: Bot,
    private readonly request: MineRequest,
  ) {
    this.#casts = new CastTargets(bot, request, MAX_MINE_TARGETS);
    this.#drops = new MineDropTracker(bot, request, this.#dropBlacklist, this.#anticipatedDropBlacklist);
  }

  isSatisfied(): boolean {
    if (!this.request.isSatisfied() || this.#water.kind !== "none") return false;
    // Incidental drops can satisfy a quantity, but a named block must also have
    // been observed removed during this run.
    const exact = this.request.exactTarget;
    return exact === undefined || this.broken.some((position) => cellKey(position) === cellKey(exact));
  }

  get waterFailure(): string | null {
    return this.#water.kind === "failed" ? this.#water.reason : null;
  }

  beginCast(): void {
    this.#water = { kind: "casting" };
  }
  endCast(): void {
    this.#water = { kind: "none" };
  }

  recoverWater(position: BlockPosition): void {
    this.#water = { kind: "pending", target: { kind: "water", position, excludedStances: new Set() } };
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  excludeWaterStance(target: MineWaterTarget, feet: BlockPosition, reason: string): void {
    this.#water = {
      kind: "pending",
      target: { ...target, excludedStances: new Set([...target.excludedStances, cellKey(feet)]) },
    };
    this.lastReason = `water at ${cellKey(target.position)} was not recovered: ${reason}`;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  get blacklisted(): number {
    return (
      this.#blockBlacklist.size +
      this.#dropBlacklist.size +
      this.#anticipatedDropBlacklist.size +
      this.#casts.blacklisted
    );
  }

  get exploring(): boolean {
    return this.#targets.length === 0 && this.#branchGoal !== null && this.#branchFailure === null;
  }

  get explorationFailure(): string | null {
    return this.#branchFailure;
  }

  failExploration(reason: string): void {
    this.#branchFailure = reason;
    this.lastReason = reason;
  }

  excludeBlockStance(target: MineBlockTarget, feet: BlockPosition): void {
    this.#blockStances.set(cellKey(target.position), new Set([...target.excludedStances, cellKey(feet)]));
    this.lastReason = `the target at ${cellKey(target.position)} is occluded from ${cellKey(feet)}`;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** A failed aiming position says nothing about the other shores of a pool. */
  excludeCastStance(target: MinePoolTarget, feet: BlockPosition, reason: string): void {
    this.#casts.excludeStance(target, feet);
    this.lastReason = reason;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  blacklist(target: MineTarget, reason?: string): void {
    switch (target.kind) {
      case "water":
        this.#water = {
          kind: "failed",
          reason: `water at ${cellKey(target.position)} could not be recovered: ${reason ?? "unreachable"}`,
        };
        this.lastReason = this.#water.reason;
        this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
        return;
      case "block":
        this.#blockBlacklist.add(cellKey(target.position));
        break;
      case "drop":
        this.#dropBlacklist.add(target.entityId);
        break;
      case "anticipated_drop":
        this.#anticipatedDropBlacklist.add(cellKey(target.position));
        break;
      case "settling_drop":
        this.#dropBlacklist.add(target.entityId);
        break;
      // A failed use or fruitless pour applies to this pool. An unavailable
      // aiming position goes through excludeCastStance instead.
      case "pool":
        this.#casts.blacklist(target);
        break;
    }
    if (reason !== undefined) this.lastReason = reason;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Blacklist the known target nearest the bot's position when calculation failed. */
  /**
   * Give up on the target nearest `position` among those the failed route
   * was asked for, and say whether there was one.
   *
   * The candidates are the current target set, not a fresh scan: the failure
   * belongs to the goal the search just answered, and a scan taken now can
   * put a lava lip or an obsidian block nearer the bot than the drop the
   * route could not reach. Blacklisting that instead left the drop in the goal
   * and the miner circling a water pocket for seven minutes.
   */
  blacklistClosest(position: { readonly x: number; readonly y: number; readonly z: number }, reason: string): boolean {
    const candidates = this.#targets.length > 0 ? this.#targets : this.refresh();
    const target = candidates.reduce<MineTarget | null>((closest, candidate) => {
      if (closest === null) return candidate;
      const candidateDistance = asVec3(candidate.position).distanceSquared(
        new Vec3(position.x, position.y, position.z),
      );
      const closestDistance = asVec3(closest.position).distanceSquared(new Vec3(position.x, position.y, position.z));
      return candidateDistance < closestDistance ? candidate : closest;
    }, null);
    if (target === null) return false;
    this.blacklist(target, reason);
    return true;
  }

  refresh(): readonly MineTarget[] {
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
    return this.targets();
  }

  /** The current target set, rescanning the world at most every `GOAL_UPDATE_MS`. */
  targets(now = Date.now()): readonly MineTarget[] {
    if (now - this.#refreshedAtMs < GOAL_UPDATE_MS) return this.#targets;

    // A block this run knew about that is loaded and no longer matches came
    // down, whoever removed it. The route breaks its own target on the way in,
    // so this is the only place a break can be observed.
    for (const position of this.#knownBlocks) {
      const block = this.bot.blockAt(asVec3(position));
      if (block === null || this.request.matches(block)) continue;
      this.broken.push(position);
      this.request.onBroken?.(position);
      this.#drops.noteBreak(position, now);
    }

    const scanResult = scan(this.bot, this.request, {
      blockCells: this.#blockBlacklist,
      blockStances: this.#blockStances,
      dropEntities: this.#dropBlacklist,
    });
    const found = [...scanResult.targets];
    this.rejections = scanResult.rejections;
    const tracked = this.#drops.update(found);
    // An item the bot stands in that never enters the inventory is one the
    // inventory cannot take. Give it up now rather than when the server
    // despawns it; whether a full bag ends the run is the caller's decision.
    for (const target of tracked) {
      if (target.kind !== "drop" || !this.#drops.pickupStalled(target.entityId, now)) continue;
      const entity = this.bot.entities[target.entityId];
      const name = (entity === undefined ? null : droppedItemName(entity)) ?? "item";
      this.blacklist(
        target,
        `the ${name} drop at ${cellKey(target.position)} was not picked up after ${DROP_PICKUP_TIMEOUT_MS / 1000} s in reach, so the inventory cannot take it`,
      );
    }
    this.#targets = tracked.filter((target) => {
      if (target.kind === "block") return !this.#blockBlacklist.has(cellKey(target.position));
      if (target.kind === "drop" || target.kind === "settling_drop") return !this.#dropBlacklist.has(target.entityId);
      return !this.#anticipatedDropBlacklist.has(cellKey(target.position));
    });
    this.#knownBlocks = this.#targets.filter((target) => target.kind === "block").map((target) => target.position);
    // Obsidian is the one block a bot manufactures, so a cast request with
    // nothing to mine makes its targets out of the lava it can see. Asked only
    // then, which keeps a second full scan off every ordinary refresh.
    if (this.#targets.length === 0) this.#targets = this.#casts.scan();
    // Recover observed drops before offering more blocks to mine. Cheap breaks
    // in a netherrack bank otherwise keep winning at the current stance until
    // the break budget is exhausted, with the requested items still on ledges.
    // Keep known blocks above so route excavation remains part of the evidence.
    if (this.#targets.some(isDropTarget)) this.#targets = this.#targets.filter(isDropTarget);
    if (this.#water.kind === "pending") {
      if (carriesWaterBucket(this.bot)) this.#water = { kind: "none" };
      else if (!isLiquidSource(this.bot, this.bot.blockAt(asVec3(this.#water.target.position)), "water")) {
        this.blacklist(this.#water.target, "the poured source is no longer observed there");
      }
    }
    if (this.#water.kind === "pending") this.#targets = [this.#water.target];
    if (this.#water.kind === "failed") this.#targets = [];
    this.#goal = this.#targets.length === 0 ? null : anyGoal(this.#targets.map((target) => coalesce(this.bot, target, this.request.movements)));
    if (this.#targets.length === 0 && this.request.explore && this.#branchGoal === null) {
      const feet = this.bot.entity.position.floored();
      this.#branchGoal = branchMiningGoal({ x: feet.x, y: feet.y, z: feet.z });
    }
    // Measure the cache window from completed work. If a rich block refresh
    // itself takes longer than the interval, recording its start time makes it
    // immediately stale and every search slice performs the whole scan again.
    this.#refreshedAtMs = Date.now();
    return this.#targets;
  }

  /**
   * The loaded lava, grouped into one target per pool at its nearest source.
   *
   * Connectivity is not asked: what the grouping is for is that a pour reaches
   * a whole neighbourhood of sources at once, and that giving up applies to
   * all of them rather than costing one route search per cell of a lake.
   */
  /** Publish the target set when it is not the one already published. */
  async announce(): Promise<void> {
    const targets = this.targets();
    const identity = targets.map(targetIdentity).join("|");
    if (identity === this.#announced) return;
    this.#announced = identity;
    await this.request.onTargets?.(targets);
  }

  /** The target nearest `position` among those the last search was asked for; see `blacklistClosest`. */
  closestTarget(position: { readonly x: number; readonly y: number; readonly z: number }): MineTarget | null {
    const origin = new Vec3(position.x, position.y, position.z);
    const candidates = this.#targets.length > 0 ? this.#targets : this.targets();
    return candidates.reduce<MineTarget | null>((closest, candidate) => {
      if (closest === null) return candidate;
      return asVec3(candidate.position).distanceSquared(origin) < asVec3(closest.position).distanceSquared(origin)
        ? candidate
        : closest;
    }, null);
  }

  /**
   * The goal Baritone revalidates rather than reissues. Every snapshot is a
   * fresh look at the world, so a route already running walks on to whatever is
   * cheapest now instead of being torn down and replanned from scratch.
   */
  goal(): Goal {
    return {
      resolve: (observation) => {
        const targets = this.targets();
        if (targets.length > 0 && this.#goal !== null) return this.#goal.resolve(observation);
        if (this.waterFailure === null && this.#branchGoal !== null) return this.#branchGoal.resolve(observation);
        return { kind: "invalid", observation: "No mineable target remains in range." } as const;
      },
    };
  }
}

async function waitForProcessTick(bot: Bot, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await bot.waitForTicks(1);
  signal?.throwIfAborted();
}

export async function mine(bot: Bot, request: MineRequest): Promise<MineResult> {
  const targeting = new MineTargeting(bot, request);
  const drive = request.route;

  let fruitlessStops = 0;
  const settle = (status: MineResult["status"]): MineResult => ({
    status: targeting.isSatisfied() ? "satisfied" : status,
    broken: targeting.broken,
    reason: targeting.lastReason,
  });

  while (!targeting.isSatisfied()) {
    request.signal?.throwIfAborted();
    if (request.stopSignal?.aborted) {
      targeting.lastReason = String(request.stopSignal.reason);
      return settle("stopped");
    }
    if (targeting.broken.length >= request.maximumBreaks) return settle("exhausted");

    const targets = targeting.targets();
    if (targeting.waterFailure !== null) return settle("unreachable");
    if (targets.length === 0) {
      // Nothing matching left, which is not the same as nothing matching ever:
      // a blacklist that has eaten every candidate means they were found and
      // could not be reached, and saying "none observed" would hide that.
      if (targeting.rejections.size > 0) {
        // The specific reasons, not "the movement policy": a model reading
        // "3 lava faces, 1 block carried" knows to collect cobblestone first.
        targeting.lastReason = rejectionSummary(targeting.rejections);
        return settle("unreachable");
      }
      if (targeting.explorationFailure !== null) return settle("stopped");
      if (!targeting.exploring) return settle(targeting.blacklisted > 0 ? "unreachable" : "no_targets");
    }
    await targeting.announce();

    if (await recoverWaterInReach(bot, request, targeting, request.signal)) continue;
    // Submerged work must occur inside navigation's scoped dive, including work already in reach.
    if (bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name !== "water" &&
      await sealAndBreakInReach(bot, request, targeting, request.signal)) continue;
    if (await castInReach(bot, request, targeting, request.signal)) continue;

    if (targeting.anticipatingDrop && targets.every(isDropTarget)) {
      // Nothing to walk to and nothing to break: let the server deliver the
      // pickup rather than asking again as fast as the loop can turn.
      await waitForProcessTick(bot, request.signal);
      continue;
    }

    const routedTargets = targets.map(targetIdentity).join("|");
    const workBefore = `${targeting.broken.length}:${request.observedInventoryGain()}`;
    const route = await runRoute(bot, request, targeting, drive);
    if (targeting.isSatisfied()) break;
    if (route.status === "stopped") {
      const currentTargets = targeting.refresh();
      if (currentTargets.map(targetIdentity).join("|") !== routedTargets) continue;
      // A live item can vanish after pickup while the route still refers to it.
      // Productive work is not evidence that the remaining block is unreachable.
      if (`${targeting.broken.length}:${request.observedInventoryGain()}` !== workBefore) {
        fruitlessStops = 0;
        continue;
      }
      fruitlessStops += 1;
      if (fruitlessStops >= MAX_FRUITLESS_STOPS) {
        targeting.lastReason = `${MAX_FRUITLESS_STOPS} routes in a row stopped without breaking or gaining anything; the last: ${route.reason}`;
        return settle("stopped");
      }
      // Baritone's `blacklistClosestOnFailure`: a goal the search could not
      // reach is not a reason to abandon mining, only that target.
      if (!targeting.blacklistClosest(bot.entity.position, route.reason)) return settle("stopped");
    } else {
      // A route can settle on the same tick that a new item entity arrives.
      // Re-open the scan at this physical boundary instead of treating the
      // callback's previously empty cache as proof that mining is finished.
      const current = targeting.refresh();
      // A route that arrives and changes nothing will arrive and change
      // nothing again. A target broken from beside it has a goal that is
      // satisfied where the bot already stands, so this is now reachable
      // rather than theoretical: give up on that target and say why, instead
      // of asking the navigator the same question until the caller's deadline.
      const idle =
        `${targeting.broken.length}:${request.observedInventoryGain()}` === workBefore &&
        current.map(targetIdentity).join("|") === routedTargets &&
        current.length > 0;
      if (idle && !targeting.blacklistClosest(bot.entity.position, "arrived, and nothing there could be broken")) {
        return settle("stopped");
      }
    }
  }

  return settle("satisfied");
}

/**
 * One leg: walk under a goal that keeps re-evaluating, and stop as soon as the
 * quantity is met rather than finishing a route nobody needs any more.
 */
async function runRoute(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  drive: Navigate,
): Promise<NavigationResult> {
  const enough = new AbortController();
  const poll = setInterval(() => {
    if (targeting.isSatisfied()) enough.abort("the requested quantity is in the inventory");
  }, 100);
  try {
    return await drive({
      movements: request.movements,
      goal: targeting.goal(),
      onArrival: async ({ signal }) => {
        if (targeting.isSatisfied() || targeting.broken.length >= request.maximumBreaks) return { kind: "completed" };

        const targets = targeting.refresh();
        await targeting.announce();
        if (targeting.isSatisfied() || targets.length === 0 || targeting.broken.length >= request.maximumBreaks)
          return { kind: "completed" };

        const acted =
          (await recoverWaterInReach(bot, request, targeting, signal)) ||
          (await sealAndBreakInReach(bot, request, targeting, signal)) ||
          (await castInReach(bot, request, targeting, signal));
        if (!acted) {
          // A stone lip can occlude a target even from an adjoining cell.
          // Re-approach that target instead of repeating the same arrival.
          if (bot.entity.onGround || Reflect.get(bot.entity, "isInWater") === true) {
            const feet = bot.entity.position.floored();
            for (const target of targets) {
              if (
                target.kind === "block" &&
                !target.routeMayBreak &&
                workingCells(bot, target, request.movements).some((cell) => cellKey(cell) === cellKey(feet)) &&
                !targetInSight(bot, bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0), target.position)
              ) {
                targeting.excludeBlockStance(target, feet);
              }
            }
          }
          // Baritone reaches this state once per client tick. Our continuation
          // callback can resolve again immediately, so wait for the next real
          // Mineflayer physics tick before evaluating the occupied drop cell.
          await waitForProcessTick(bot, signal);
        }

        return targeting.isSatisfied() || targeting.broken.length >= request.maximumBreaks
          ? { kind: "completed" }
          : { kind: "continue" };
      },
      onCalculationFailure: async ({ failure, observation, signal }) => {
        const failedTarget = targeting.closestTarget(observation.position);
        if (failedTarget === null) {
          targeting.failExploration(describeCalculationFailure(failure));
          return { kind: "completed" };
        }
        if (failedTarget.kind === "drop" && targeting.dropInFlight(failedTarget.entityId)) {
          // A top log's item is initially too high for any pickup stance.
          // Let its native flight settle before judging reachability. Contact
          // with a block/fluid, disappearance, or cancellation ends this wait;
          // a stationary unreachable item still takes the blacklist path below.
          do {
            await waitForProcessTick(bot, signal);
          } while (targeting.dropInFlight(failedTarget.entityId) && !targeting.isSatisfied());
          targeting.refresh();
          await targeting.announce();
          return targeting.isSatisfied() ? { kind: "completed" } : { kind: "continue" };
        }
        // Only an in-flight packet transition has something left to wait for.
        // A live unreachable item can remain forever; waiting there drowned
        // the miner after a failed route into a water-filled pickup hole.
        if (failedTarget.kind === "anticipated_drop" || failedTarget.kind === "settling_drop") {
          const failedDrop = targetIdentity(failedTarget);
          for (;;) {
            await waitForProcessTick(bot, signal);
            const waitingTargets = targeting.refresh();
            await targeting.announce();
            if (targeting.isSatisfied() || waitingTargets.length === 0) return { kind: "completed" };
            const failedDropStillExists = waitingTargets.some((target) => targetIdentity(target) === failedDrop);
            if (!failedDropStillExists) return { kind: "continue" };
          }
        }
        const blacklisted = targeting.blacklistClosest(observation.position, describeCalculationFailure(failure));
        if (!blacklisted) return { kind: "completed" };

        const targets = targeting.refresh();
        await targeting.announce();
        return targets.length === 0 ? { kind: "completed" } : { kind: "continue" };
      },
      signal: request.signal,
      stopSignal: request.stopSignal
        ? AbortSignal.any([enough.signal, request.stopSignal])
        : enough.signal,
    });
  } finally {
    clearInterval(poll);
  }
}
