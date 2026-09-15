/** The work to remove a block, independent of why its caller wants it gone. */
import { type BlockRaycaster, STANDING_EYE_HEIGHT, visibleBlockAim } from "../../world/block-visibility.js";
import { NO_OBSTACLE, obstaclesOf, worldViewRaycaster } from "../world/line-of-sight.js";
import { hasUnstableFallingSupport, navigationFeet } from "../world/block-geometry.js";
import type { BlockPosition, CollisionBox, LoadedBlock, Position3, WorldView } from "../world/world.js";
import { blockKey, blockLabel, packKey } from "../world/world.js";
import type { BreakEvaluation, DigContext, MovementPolicy } from "./policy.js";

/** Mineflayer canDigBlock measures block centre from feet + 1.65, within 5.1 blocks. */
export const DIG_REACH = 5.1;

export interface Dig {
  readonly position: BlockPosition;
  readonly stateId: number;
  readonly toolType: number | null;
  /** Ticks to break this block and everything in `brings`. */
  readonly expectedTicks: number;
  readonly penalty: number;
  /**
   * Falling blocks above this cell that removing it brings down into it,
   * lowest first. They cannot be seen from the stance until they fall, so they
   * are not digs of their own: their work is charged here, their cells are
   * cleared here, and each one lands as a world change the route replans on
   * and breaks where it now stands — Baritone's `pauseMiningForFallingBlocks`
   * loop, one replan per block.
   */
  readonly brings: readonly BlockPosition[];
}

export type Excavation =
  | {
      readonly kind: "prepared";
      readonly digs: readonly Dig[];
      readonly breakTicks: number;
      readonly breakPenalty: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

type PricedExcavation =
  | { readonly kind: "priced"; readonly digs: readonly Dig[] }
  | { readonly kind: "unavailable"; readonly reason: string };

const unavailable = (reason: string): PricedExcavation => ({ kind: "unavailable", reason });

export function priceExcavation(options: {
  readonly world: WorldView;
  readonly policy: MovementPolicy;
  readonly position: BlockPosition;
  readonly digContext: DigContext;
}): PricedExcavation {
  const { world, policy, position, digContext } = options;
  const target = world.blockAt(position.x, position.y, position.z);
  if (target.kind === "unloaded") return unavailable("The block is not loaded.");
  // Collision-free is not absent: cobwebs and other passable, diggable blocks
  // still require a real break when they are the requested excavation.
  if (target.traits.empty && !target.traits.safeToBreak) return { kind: "priced", digs: [] };
  if (!policy.allowDigging) return unavailable("Digging is disabled.");
  // The falling column above the target is part of the work, even when only
  // the target's support is wanted; it is priced top down. Most targets have
  // nothing falling above them, and are priced without building the column.
  let top = position.y;
  for (;;) {
    const block = world.blockAt(position.x, top + 1, position.z);
    if (block.kind === "unloaded") return unavailable("The column above the target is not loaded.");
    if (!block.traits.falling) break;
    top += 1;
  }
  const digs: Dig[] = [];
  for (let y = top; y >= position.y; y -= 1) {
    const at = y === position.y ? position : { x: position.x, y, z: position.z };
    const block = y === position.y ? target : (world.blockAt(at.x, at.y, at.z) as LoadedBlock);
    const evaluation = policy.evaluateBreak(block, at, world);
    if (evaluation.decision.kind === "prohibited") return unavailable(evaluation.decision.reason);
    digs.push(digOf(policy, block, at, evaluation, digContext));
  }
  return { kind: "priced", digs };
}

function digOf(
  policy: MovementPolicy,
  block: LoadedBlock,
  position: BlockPosition,
  evaluation: BreakEvaluation,
  digContext: DigContext,
): Dig {
  return {
    position,
    stateId: block.stateId,
    toolType: evaluation.tool.itemType,
    expectedTicks: policy.digTimeEstimator.estimate(block, evaluation.tool, digContext),
    penalty: evaluation.decision.kind === "penalized" ? evaluation.decision.cost : 0,
    brings: NO_BRINGS,
  };
}

const NO_BRINGS: readonly BlockPosition[] = Object.freeze([]);

/**
 * Whether removing this cell lets lava in.
 *
 * The column above is not the only thing a solid block holds back. Lava
 * beside the cell pours into the corridor the moment it is removed, which
 * the overlay does not model and the bot cannot survive.
 *
 * Deliberately lava only. Water is also released laterally, but it is
 * survivable, and the underwater fixtures dig through cells that are
 * adjacent to water by construction; excluding those would remove real
 * capability to prevent an inconvenience.
 */
export function releasesLava(blockAt: WorldView["blockAt"], x: number, y: number, z: number): boolean {
  for (const lateral of LATERALS) {
    const neighbour = blockAt(x + lateral.x, y, z + lateral.z);
    if (neighbour.kind === "loaded" && neighbour.traits.liquid === "lava") return true;
  }
  return false;
}

const LATERALS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
] as const;

/** Whether every dig a movement priced by state may be made where it is, by the policy's rules that read around the cell. */
export function confirmDigs(policy: MovementPolicy, world: WorldView, digs: readonly Dig[]): boolean {
  for (const dig of digs) {
    const block = world.blockAt(dig.position.x, dig.position.y, dig.position.z);
    if (policy.confirmBreak(block, dig.position, world).kind === "prohibited") return false;
  }
  return true;
}

/** Mineflayer's `canDigBlock` rule: block centre within `DIG_REACH` of a point 1.65 above the feet. */
function withinDigReach(position: BlockPosition, standing: Position3): boolean {
  const dx = position.x + 0.5 - standing.x;
  const dy = position.y + 0.5 - (standing.y + 1.65);
  const dz = position.z + 0.5 - standing.z;
  return dx * dx + dy * dy + dz * dz <= DIG_REACH ** 2;
}

/**
 * Which digs can be made from one stance.
 *
 * Baritone never breaks a block it cannot see. `Movement.prepared` asks
 * `RotationUtils.reachable(ctx, blockPos, blockReachDistance)` for each
 * position to break and only clicks when the eye ray lands on that block; its
 * fallback aims at the centre and is, in its own words, "intended to be
 * breaking the 'incorrect' block" — whatever actually stands in front.
 * `MineProcess.onTick` guards its shaft break with the same call. Judging
 * reach by distance alone let search plan a dig through the wall in front of
 * it, and a vanilla server breaks whichever block the client names, so the
 * bot dug dirt out of the stone around it and never saw the drop.
 *
 * Every movement out of a node digs from the same stance, so what the eye can
 * see of each cell through the untouched world is remembered across them.
 */
export interface StanceSight {
  readonly standing: Position3;
  /** Whether the dig is within reach and visible once the cells in `cleared`, packed keys, are out of the way. */
  canSee(dig: Dig, cleared: readonly number[]): boolean;
}

export function stanceSight(blockAt: WorldView["blockAt"], standing: Position3): StanceSight {
  const eye = { x: standing.x, y: standing.y + STANDING_EYE_HEIGHT, z: standing.z };
  const untouched = worldViewRaycaster((x, y, z) => obstaclesOf(blockAt(x, y, z)));
  const seen = new Map<number, boolean>();
  const aims = (rays: BlockRaycaster, dig: Dig): boolean => {
    const { x, y, z } = dig.position;
    return visibleBlockAim(rays, eye, dig.position, DIG_REACH, obstaclesOf(blockAt(x, y, z)) ?? []) !== null;
  };
  const feetX = Math.floor(standing.x);
  const feetY = Math.floor(standing.y);
  const feetZ = Math.floor(standing.z);
  const centred = standing.x - feetX === 0.5 && standing.z - feetZ === 0.5 && standing.y === feetY;
  /** The untouched-world answer: by the ray's known path when the target is a cube, by the ray itself otherwise. */
  const seesUntouched = (dig: Dig): boolean => {
    const { x, y, z } = dig.position;
    const target = blockAt(x, y, z);
    if (!centred || target.kind !== "loaded" || !target.geometry.fullCube) return aims(untouched, dig);
    const faces = rayTemplate(x - feetX, y - feetY, z - feetZ);
    if (faces === AMBIGUOUS) return aims(untouched, dig);
    for (const face of faces) {
      let verdict: "clear" | "blocked" | "unsure" = "clear";
      for (let index = 0; index < face.cells.length; index += 3) {
        const cell = blockAt(feetX + face.cells[index]!, feetY + face.cells[index + 1]!, feetZ + face.cells[index + 2]!);
        const obstacles = obstaclesOf(cell);
        if (obstacles === null || (cell.kind === "loaded" && cell.geometry.fullCube)) {
          verdict = "blocked";
          break;
        }
        if (obstacles.length > 0) {
          verdict = "unsure";
          break;
        }
      }
      if (verdict === "clear") return true;
      if (verdict === "unsure") return aims(untouched, dig);
    }
    return false;
  };
  return {
    standing,
    canSee(dig, cleared) {
      if (!withinDigReach(dig.position, standing)) return false;
      const key = blockKey(dig.position);
      let visible = seen.get(key);
      if (visible === undefined) {
        visible = seesUntouched(dig);
        seen.set(key, visible);
      }
      // Clearing only ever removes obstacles, so a dig seen through the
      // untouched world stays seen; one that was not may come into view once
      // the digs before it are out of the way.
      if (visible || cleared.length === 0) return visible;
      const rays = worldViewRaycaster((x, y, z) =>
        cleared.includes(packKey(x, y, z)) ? NO_OBSTACLE : obstaclesOf(blockAt(x, y, z)),
      );
      return aims(rays, dig);
    },
  };
}

/**
 * The cells an eye ray crosses on its way to one face of a full-cube target,
 * as x, y, z offsets from the feet cell, three numbers per cell, for each
 * face `visibleBlockAim` would try, in the order it tries them.
 *
 * From a stance at a cell's centre the eye sits at a fixed offset from the
 * feet, so the path to a target depends only on the target's offset. The
 * path is walked once per offset by the same walker the ray uses, over an
 * empty world with the target as its only obstacle; a face the ray cannot
 * reach within `DIG_REACH` is left out. Checking a path is then a lookup per
 * cell: empty cells let the ray through, full cubes stop it, and anything
 * else hands the question back to the ray.
 */
interface RayPath {
  readonly cells: readonly number[];
}

/** A target whose rays graze a cell edge: which side they step to is a matter of rounding, so the ray itself decides. */
const AMBIGUOUS = Symbol("ambiguous");

const rayTemplates = new Map<number, readonly RayPath[] | typeof AMBIGUOUS>();

function rayTemplate(dx: number, dy: number, dz: number): readonly RayPath[] | typeof AMBIGUOUS {
  const key = (dx + 16) * 1024 + (dy + 16) * 32 + (dz + 16);
  let paths = rayTemplates.get(key);
  if (paths === undefined) {
    paths = tracePathsExactly(dx, dy, dz);
    rayTemplates.set(key, paths);
  }
  return paths;
}

const FULL_CUBE: readonly CollisionBox[] = Object.freeze([
  Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }),
]);

/**
 * A ray through the exact edge between two cells steps into whichever the
 * last bit of arithmetic favours, and the real eye sits at a world height
 * whose rounding differs from the template's. Nudging the eye a hair on
 * each axis flips exactly those ties and nothing else, so a target whose
 * paths change under the nudge is left to the ray.
 */
function tracePathsExactly(dx: number, dy: number, dz: number): readonly RayPath[] | typeof AMBIGUOUS {
  const nudge = 1e-7;
  const reference = tracePaths(dx, dy, dz, 0, 0, 0);
  const same = (paths: readonly RayPath[]) =>
    paths.length === reference.length &&
    paths.every((path, index) => {
      const other = reference[index]!.cells;
      return path.cells.length === other.length && path.cells.every((cell, at) => cell === other[at]);
    });
  for (const [ex, ey, ez] of [
    [nudge, 0, 0],
    [0, nudge, 0],
    [0, 0, nudge],
    [-nudge, 0, 0],
    [0, -nudge, 0],
    [0, 0, -nudge],
  ]) {
    if (!same(tracePaths(dx, dy, dz, ex!, ey!, ez!))) return AMBIGUOUS;
  }
  return reference;
}

function tracePaths(dx: number, dy: number, dz: number, ex: number, ey: number, ez: number): readonly RayPath[] {
  const eye = { x: 0.5 + ex, y: STANDING_EYE_HEIGHT + ey, z: 0.5 + ez };
  const paths: RayPath[] = [];
  let crossed: number[] = [];
  const recorder = worldViewRaycaster((x, y, z) => {
    if (x === dx && y === dy && z === dz) return FULL_CUBE;
    crossed.push(x, y, z);
    return NO_OBSTACLE;
  });
  // `visibleBlockAim` tries the faces facing the eye in the order y, x, z,
  // and each try is one ray; recording what each ray crosses on the way to
  // the target gives one path per face, in that order. Every ray is reported
  // back as a miss so that all the faces are tried and recorded.
  const tracing: BlockRaycaster = {
    raycast(from, direction, range) {
      crossed = [];
      const hit = recorder.raycast(from, direction, range);
      if (hit !== null) {
        const position = "position" in hit ? hit.position : hit;
        if (position.x === dx && position.y === dy && position.z === dz) paths.push({ cells: crossed });
      }
      return null;
    },
  };
  const target = { x: dx, y: dy, z: dz };
  if (visibleBlockAim(tracing, eye, target, DIG_REACH, FULL_CUBE) !== null) {
    // The eye is inside the target's box; no ray is cast, and the cell can be cleared from within.
    paths.push({ cells: [] });
  }
  return paths;
}

const NO_DIGS: readonly Dig[] = Object.freeze([]);
/** The excavation of a movement with nothing to dig, so a caller that knows it has none need not ask. */
export const NOTHING_TO_CLEAR: Excavation = Object.freeze({
  kind: "prepared",
  digs: NO_DIGS,
  breakTicks: 0,
  breakPenalty: 0,
});

/**
 * Combine overlapping clearance work and order it so that every dig can be
 * seen from the stance when its turn comes.
 *
 * Digs are taken highest visible first, each clearing its cell for the ray to
 * the next, so a column beside the bot comes down from the top. A falling
 * column that cannot be seen — sand above a plug across a corridor, under a
 * ceiling — is not planned as digs at all: it is brought down by the visible
 * dig beneath it and charged to that dig (see `Dig.brings`). A dig in the
 * bot's own column is refused while a falling block still stands above it,
 * because removing it would drop that block onto the bot.
 */
export function prepareExcavationDigs(
  blockAt: WorldView["blockAt"],
  sight: StanceSight,
  candidates: readonly Dig[],
): Excavation {
  if (candidates.length === 0) return NOTHING_TO_CLEAR;
  const feet = navigationFeet(sight.standing, true);
  if (hasUnstableFallingSupport(blockAt, feet.x, feet.y - 1, feet.z)) {
    return {
      kind: "unavailable",
      reason: "The falling-block column beneath the mining stance has no observed stable support.",
    };
  }
  // A movement clears one to three cells, so this is plain loops over short
  // arrays: search calls it for every candidate that digs.
  const remaining = uniqueHighestFirst(candidates);
  const digs: Dig[] = [];
  let breakTicks = 0;
  let breakPenalty = 0;

  const { standing } = sight;
  const feetX = Math.floor(standing.x);
  const feetZ = Math.floor(standing.z);
  const cleared: number[] = [];
  while (remaining.length > 0) {
    let index = 0;
    while (index < remaining.length && !sight.canSee(remaining[index]!, cleared)) index += 1;
    const dig = remaining[index];
    if (dig === undefined) {
      const hidden = remaining[0]!.position;
      return {
        kind: "unavailable",
        reason: `The required dig at ${blockLabel(hidden)} cannot be seen within reach from this position.`,
      };
    }
    if (dig.position.x === feetX && dig.position.z === feetZ && dig.position.y < standing.y) {
      const below = blockAt(dig.position.x, dig.position.y - 1, dig.position.z);
      const body = blockAt(feetX, Math.floor(standing.y), feetZ);
      if (below.kind === "loaded" && below.traits.liquid === "water" &&
        (body.kind !== "loaded" || body.traits.liquid !== "water")) {
        return { kind: "unavailable", reason: "The dig would remove the miner's dry footing above water." };
      }
    }
    if (dig.position.x === feetX && dig.position.z === feetZ && dig.position.y > standing.y) {
      const above = blockAt(dig.position.x, dig.position.y + 1, dig.position.z);
      if (
        above.kind === "loaded" &&
        above.traits.falling &&
        !cleared.includes(packKey(dig.position.x, dig.position.y + 1, dig.position.z))
      ) {
        return {
          kind: "unavailable",
          reason: `The dig at ${blockLabel(dig.position)} would drop the falling block above it onto the bot.`,
        };
      }
    }
    remaining.splice(index, 1);
    cleared.push(packKey(dig.position.x, dig.position.y, dig.position.z));
    // Whatever falling column still stands directly above this dig lands in
    // its cell once it goes, so it is this dig's work rather than its own.
    let brings: BlockPosition[] | null = null;
    let expectedTicks = dig.expectedTicks;
    let penalty = dig.penalty;
    for (let y = dig.position.y + 1; ; y += 1) {
      const aboveIndex = indexOfCell(remaining, dig.position.x, y, dig.position.z);
      if (aboveIndex < 0) break;
      const above = remaining[aboveIndex]!;
      const block = blockAt(above.position.x, above.position.y, above.position.z);
      if (block.kind !== "loaded" || !block.traits.falling) break;
      remaining.splice(aboveIndex, 1);
      cleared.push(packKey(above.position.x, above.position.y, above.position.z));
      (brings ??= []).push(above.position);
      expectedTicks += above.expectedTicks;
      penalty += above.penalty;
    }
    digs.push(brings === null ? dig : { ...dig, expectedTicks, penalty, brings });
    breakTicks += expectedTicks;
    breakPenalty += penalty;
  }
  return { kind: "prepared", digs, breakTicks, breakPenalty };
}

/** The candidates once each, highest first; a cell two of a movement's cells share is dug once. */
function uniqueHighestFirst(candidates: readonly Dig[]): Dig[] {
  const unique: Dig[] = [];
  for (const dig of candidates) {
    if (indexOfCell(unique, dig.position.x, dig.position.y, dig.position.z) < 0) unique.push(dig);
  }
  if (unique.length > 1) unique.sort((left, right) => right.position.y - left.position.y);
  return unique;
}

function indexOfCell(digs: readonly Dig[], x: number, y: number, z: number): number {
  for (let index = 0; index < digs.length; index += 1) {
    const at = digs[index]!.position;
    if (at.x === x && at.y === y && at.z === z) return index;
  }
  return -1;
}

/** Prepare one target; movement families combine their cells before preparing their digs. */
export function prepareExcavation(options: {
  readonly world: WorldView;
  readonly policy: MovementPolicy;
  readonly position: BlockPosition;
  readonly standing: Position3;
  readonly digContext: DigContext;
}): Excavation {
  const work = priceExcavation(options);
  if (work.kind === "unavailable") return work;
  const blockAt = (x: number, y: number, z: number) => options.world.blockAt(x, y, z);
  return prepareExcavationDigs(blockAt, stanceSight(blockAt, options.standing), work.digs);
}
