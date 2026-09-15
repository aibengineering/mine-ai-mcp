import { COAST_TICKS } from "../../world/player-physics.js";
import {
  blockPosition,
  type BlockObservation,
  type BlockPosition,
  type BlockTraits,
  type CollisionBox,
  type Position3,
  type WorldView,
} from "./world.js";

/** Releasing input must leave the body's remaining coast over safe ground. */
export function canReleaseOnObservedGround(
  world: WorldView,
  body: { readonly position: Position3; readonly velocity: Position3; readonly onGround: boolean },
): boolean {
  if (!body.onGround) return false;
  const dx = body.velocity.x * COAST_TICKS;
  const dz = body.velocity.z * COAST_TICKS;
  const samples = Math.max(1, Math.ceil(Math.hypot(dx, dz) * 2));
  for (let index = 0; index <= samples; index++) {
    const at = navigationFeet(
      { x: body.position.x + (dx * index) / samples, y: body.position.y, z: body.position.z + (dz * index) / samples },
      true,
    );
    if (
      !isSafeSupport(world.blockAt(at.x, at.y - 1, at.z)) ||
      !isPassable(world.blockAt(at.x, at.y, at.z)) ||
      !isHeadPassable(world.blockAt(at.x, at.y + 1, at.z))
    )
      return false;
  }
  return true;
}

/** A horizontal landing corridor stays supported, or ends against a full wall. */
export function hasSupportedCorridor(world: WorldView, from: Position3, displacement: Position3): boolean {
  const samples = Math.max(1, Math.ceil(Math.hypot(displacement.x, displacement.z) * 4));
  const y = navigationFeet(from, true).y;
  for (let sample = 0; sample <= samples; sample++) {
    const px = from.x + (displacement.x * sample) / samples;
    const pz = from.z + (displacement.z * sample) / samples;
    const feet = world.blockAt(Math.floor(px), y, Math.floor(pz));
    const head = world.blockAt(Math.floor(px), y + 1, Math.floor(pz));
    // A two-block solid wall catches the body; a one-block lip can be hopped.
    if (sample > 0 && isSafeSupport(feet) && isSafeSupport(head)) return true;
    for (let x = Math.floor(px - 0.3); x <= Math.floor(px + 0.3); x++)
      for (let z = Math.floor(pz - 0.3); z <= Math.floor(pz + 0.3); z++) {
        // The body meets a wall before its centre enters the wall's cell.
        if (isSafeSupport(world.blockAt(x, y, z)) && isSafeSupport(world.blockAt(x, y + 1, z))) continue;
        if (
          !isSafeSupport(world.blockAt(x, y - 1, z)) ||
          !isPassable(world.blockAt(x, y, z)) ||
          !isHeadPassable(world.blockAt(x, y + 1, z))
        )
          return false;
      }
  }
  return true;
}

/** Find safe support under the player's whole footprint, including a centre over air. */
export function safeSupportingCell(world: WorldView, position: Position3): BlockPosition | null {
  const { y } = navigationFeet(position, true);
  let nearest: BlockPosition | null = null;
  const distance = (at: BlockPosition) => Math.hypot(at.x + 0.5 - position.x, at.z + 0.5 - position.z);
  for (let x = Math.floor(position.x - 0.3); x < position.x + 0.3; x++)
    for (let z = Math.floor(position.z - 0.3); z < position.z + 0.3; z++) {
      const floor = world.blockAt(x, y - 1, z);
      if (
        floor.kind !== "loaded" ||
        floor.traits.damaging ||
        floor.traits.liquid === "lava" ||
        !isPassable(world.blockAt(x, y, z)) ||
        !isHeadPassable(world.blockAt(x, y + 1, z))
      )
        return null;
      const at = { x, y, z };
      if (isSafeSupport(floor) && (!nearest || distance(at) < distance(nearest))) nearest = at;
    }
  return nearest;
}

/**
 * Collision this low is walked over as a matter of course: a carpet, a
 * single snow layer, a pressure plate. Counted as a floor instead, the cell
 * above it became the standing cell while the bot's feet stayed in this one,
 * and the ninth playthrough's routes failed to settle on a moss carpet twice.
 */
const THIN_BLOCK_HEIGHT = 0.125;

// Soul sand and mud lower a full-width floor by one eighth of a block.
// A one-node ascent from that floor is still within Minecraft's normal jump.
const FLOOR_HEIGHT_DEFICIT = 0.125;

/** The planned feet cell above a supported floor, preserving the physical position separately. */
export function navigationFeet(position: Position3, onGround: boolean): BlockPosition {
  return blockPosition({ ...position, y: position.y + (onGround ? FLOOR_HEIGHT_DEFICIT : 0) });
}

/**
 * What one block state's shape means for a body, settled once per state.
 *
 * Search asks these questions hundreds of times per node, and Baritone
 * answers them from a table precomputed per block state rather than from the
 * collision boxes each time. `describeBlockGeometry` is that table's row,
 * built by `loadedObservation`; the predicates below read it. The rules live
 * here and nowhere else.
 */
export interface BlockGeometry {
  /** The body may occupy the cell at floor level. */
  readonly passable: boolean;
  /** The body's head and chest fit through the cell. */
  readonly headPassable: boolean;
  /** Collision the body cannot walk over. */
  readonly solid: boolean;
  /** Collision low enough to walk over. */
  readonly thin: boolean;
  /** Solid enough to stand on top of. */
  readonly standableTop: boolean;
  /** Solid enough to stand on, and safe to stand on. */
  readonly safeSupport: boolean;
  /** One collision box filling the whole cell: a ray into the cell meets it at the cell's face. */
  readonly fullCube: boolean;
}

/** How far a block's collision reaches above the floor of its own cell. */
function collisionHeight(shapes: readonly CollisionBox[]): number {
  let highest = 0;
  for (const box of shapes) if (box.maxY > highest) highest = box.maxY;
  return highest;
}

export function describeBlockGeometry(traits: BlockTraits, shapes: readonly CollisionBox[]): BlockGeometry {
  const hasCollision = !traits.empty && traits.liquid === null && shapes.length > 0;
  const height = collisionHeight(shapes);
  const thin = hasCollision && height <= THIN_BLOCK_HEIGHT;
  const solid = hasCollision && !thin;
  // Passability without a surrounding-column check. Source water is accepted;
  // flowing water also needs the support and surface checks in prepareCell.
  const passable =
    traits.liquid !== "lava" &&
    !traits.damaging &&
    ((traits.empty && traits.liquid === null) ||
      (traits.liquid === "water" && traits.liquidSource) ||
      traits.climbable ||
      (traits.openable && traits.open) ||
      thin);
  // Thin collision is walked over at floor level, which is the whole reason
  // `passable` accepts it. One cell up it is not a floor: a 1.8-block body
  // fills feet+1.0 to feet+1.8, and a carpet resting on the carpet below it
  // sits exactly there. Judged on thinness alone the cell reads as free, and
  // observed live on 2026-09-04 the bot drove into a stacked pair of moss
  // carpets, could not enter, and never considered the clear lane beside it.
  const headPassable = passable && !thin;
  // Solid enough to stand on *top of*. A fence, wall, or gate is a
  // full-collision block whose box reaches 1.5, so standing on it is a step
  // of a block and a half, higher than any jump. Judged only by `solid` the
  // planner offers that step, the bot fails it against real physics, the
  // route replans onto the identical step, and it retries for as long as it
  // has patience. Baritone keeps the same blocks out of `canWalkOn`. The
  // height is read from the collision boxes the world reports rather than
  // from a list of block names, so a slab, a carpet, or a mod's own fence is
  // judged by what it actually is. The broad, nearly full-height floor of
  // soul sand and mud is accepted; narrow stalagmite tips and lower slabs
  // do not provide that same walking surface.
  // A ladder's plate reaches the full height of its cell, so by height alone
  // it is a tread; but a body that jumps up into a ladder cell hangs in it
  // rather than landing, and the step-up that expected support never settled.
  // Climbables are support to walk over and climb into (`safeSupport`
  // below), never a tread to step up onto.
  // A big dripleaf's box is a full-width tread within an eighth of full
  // height, and by that reading alone it is a floor. It is the one block whose
  // collision answers to what stands on it: a body on the leaf tilts it in
  // ten ticks, drops it in twenty, and is standing in whatever was beneath
  // when the leaf resets flat above it five seconds later. Observed live on
  // 2026-09-12 in a lush cave, where a hunt walked onto the leaf over a
  // one-deep pool, fell in, and was held under the reset leaf for the rest
  // of the request; `scenarios/flat/hunt/dripleaf-pool-trap.yaml` is the
  // fixture. The trait comes from the block name, as `damaging` does, because
  // no box says that it will move.
  const standableTop =
    solid &&
    !traits.climbable &&
    !traits.yielding &&
    (height === 1 ||
      (height < 1 &&
        height >= 1 - FLOOR_HEIGHT_DEFICIT &&
        shapes.some(
          (box) => box.maxY === height && box.minX === 0 && box.minZ === 0 && box.maxX === 1 && box.maxZ === 1,
        )));
  // `solid` alone accepts a magma walkway: it is a full cube with collision,
  // so every geometric test passes while the bot takes contact damage for
  // the length of the route. A ladder or vine beneath the feet is support of
  // another kind: the body hangs in it rather than stands on it, and it can
  // be climbed down into. Baritone's `canWalkOn` says the same of ladders,
  // `if (block == Blocks.LADDER || (block == Blocks.VINE &&
  // Baritone.settings().allowVines.value))`; vines follow the `allowClimbing`
  // policy here, as they already do on the way up.
  const safeSupport = (standableTop || traits.climbable) && !traits.damaging;
  const box = shapes[0];
  const fullCube =
    hasCollision &&
    shapes.length === 1 &&
    box !== undefined &&
    box.minX === 0 &&
    box.minY === 0 &&
    box.minZ === 0 &&
    box.maxX === 1 &&
    box.maxY === 1 &&
    box.maxZ === 1;
  return Object.freeze({ passable, headPassable, solid, thin, standableTop, safeSupport, fullCube });
}

/**
 * The geometry as bits on the observation, so the predicates search asks of
 * every cell it looks at are one load and a mask; an unloaded cell carries
 * no bits and answers no to all of them.
 */
export const GEOMETRY_PASSABLE = 1;
export const GEOMETRY_HEAD_PASSABLE = 2;
export const GEOMETRY_SOLID = 4;
export const GEOMETRY_THIN = 8;
export const GEOMETRY_STANDABLE_TOP = 16;
export const GEOMETRY_SAFE_SUPPORT = 32;
export const GEOMETRY_FULL_CUBE = 64;
/** The traits the movement families ask of every cell, as bits beside the geometry. */
export const TRAIT_WATER = 128;
export const TRAIT_LAVA = 256;
export const TRAIT_LIQUID_SOURCE = 512;
export const TRAIT_FALLING = 1024;
export const TRAIT_CLIMBABLE = 2048;
export const TRAIT_OPENABLE = 4096;
export const TRAIT_EMPTY = 8192;
export const TRAIT_DAMAGING = 16384;
const TRAIT_LIQUID = TRAIT_WATER | TRAIT_LAVA;

export function observationBits(geometry: BlockGeometry, traits: BlockTraits): number {
  return (
    (geometry.passable ? GEOMETRY_PASSABLE : 0) |
    (geometry.headPassable ? GEOMETRY_HEAD_PASSABLE : 0) |
    (geometry.solid ? GEOMETRY_SOLID : 0) |
    (geometry.thin ? GEOMETRY_THIN : 0) |
    (geometry.standableTop ? GEOMETRY_STANDABLE_TOP : 0) |
    (geometry.safeSupport ? GEOMETRY_SAFE_SUPPORT : 0) |
    (geometry.fullCube ? GEOMETRY_FULL_CUBE : 0) |
    (traits.liquid === "water" ? TRAIT_WATER : 0) |
    (traits.liquid === "lava" ? TRAIT_LAVA : 0) |
    (traits.liquidSource ? TRAIT_LIQUID_SOURCE : 0) |
    (traits.falling ? TRAIT_FALLING : 0) |
    (traits.climbable ? TRAIT_CLIMBABLE : 0) |
    (traits.openable ? TRAIT_OPENABLE : 0) |
    (traits.empty ? TRAIT_EMPTY : 0) |
    (traits.damaging ? TRAIT_DAMAGING : 0)
  );
}

/** A loaded cell holding water, flowing or still. */
export function isWater(block: BlockObservation): boolean {
  return (block.bits & TRAIT_WATER) !== 0;
}

export function isLava(block: BlockObservation): boolean {
  return (block.bits & TRAIT_LAVA) !== 0;
}

/** A loaded cell holding any liquid. */
export function isLiquid(block: BlockObservation): boolean {
  return (block.bits & TRAIT_LIQUID) !== 0;
}

/** A loaded cell holding neither liquid nor anything unloaded: dry, whatever else it holds. */
export function isDry(block: BlockObservation): boolean {
  return block.kind === "loaded" && (block.bits & TRAIT_LIQUID) === 0 && !block.traits.waterlogged;
}

export function isFalling(block: BlockObservation): boolean {
  return (block.bits & TRAIT_FALLING) !== 0;
}

export function isClimbable(block: BlockObservation): boolean {
  return (block.bits & TRAIT_CLIMBABLE) !== 0;
}

export function isThin(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_THIN) !== 0;
}

export function isSolid(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_SOLID) !== 0;
}

export function isPassable(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_PASSABLE) !== 0;
}

export function isHeadPassable(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_HEAD_PASSABLE) !== 0;
}

export function isStandableTop(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_STANDABLE_TOP) !== 0;
}

export function isSafeSupport(block: BlockObservation): boolean {
  return (block.bits & GEOMETRY_SAFE_SUPPORT) !== 0;
}

/**
 * A gravel floor can have a solid shape while hanging over air. A neighbouring
 * dig wakes its gravity, so a route may rely on it only when the whole falling
 * column rests on an observed floor. Ordinary support takes one bit check.
 * Read through the planning view so earlier digs and scaffolds count.
 */
export function hasUnstableFallingSupport(blockAt: WorldView["blockAt"], x: number, y: number, z: number): boolean {
  let block = blockAt(x, y, z);
  if (!isFalling(block)) return false;
  do {
    block = blockAt(x, --y, z);
  } while (isFalling(block));
  return !isStandableTop(block);
}
