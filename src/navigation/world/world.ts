/**
 * What can be observed: positions, blocks, the view search reads, and the
 * player and entities as one observation.
 *
 * These are facts. Predicted edits are a planning hypothesis and live with
 * search, not here. The Mineflayer producers of every shape here live in
 * `mineflayer/world.ts` and `mineflayer/bot.ts`.
 */
import { type BlockGeometry, describeBlockGeometry, observationBits } from "./block-geometry.js";

/** One block cell: integer coordinates, the unit search plans in. */
export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A point in continuous space, such as where an entity actually is. */
export interface Position3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CollisionBox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface BlockTraits {
  readonly empty: boolean;
  readonly liquid: "water" | "lava" | null;
  readonly liquidSource: boolean;
  /** Water held by a plant or waterlogged solid, independently of its collision. */
  readonly waterlogged: boolean;
  /**
   * The state carries a `waterlogged` property, so poured water enters this
   * block instead of forming a source in the cell beside it. Leaves, slabs and
   * stairs absorb a water landing that a stone floor would hold up.
   */
  readonly waterloggable: boolean;
  readonly climbable: boolean;
  readonly openable: boolean;
  readonly open: boolean;
  /**
   * The openable family this block belongs to, such as `oak_door`, or null.
   * `activationGroupAt` combines it with the cell to name the one thing a
   * door's two halves both activate.
   */
  readonly activationGroup: string | null;
  /** The upper half of a two-block openable; activation targets the lower. */
  readonly upperHalf: boolean;
  readonly falling: boolean;
  /**
   * Collision that gives way under a standing body. A big dripleaf reads as a
   * near-full floor by its boxes, but a body on it tilts it within a second
   * and drops through; see `standableTop` in `block-geometry.ts`.
   */
  readonly yielding: boolean;
  /** Contact harms the player: magma, fire, cactus, berry bushes. */
  readonly damaging: boolean;
  /** Right-clicking this block opens or operates it instead of placing against it. */
  readonly interactive: boolean;
  /** How far a parkour jump can start from this block's top. */
  readonly parkourTakeoff: "normal" | "short" | "prohibited";
  readonly safeToBreak: boolean;
}

/**
 * What a cell holds, described by its block state alone.
 *
 * An observation carries no position, so one object can describe every cell
 * holding the same state: a `WorldView` answers `blockAt` with a shared,
 * immutable observation per state id and allocates nothing per lookup. The
 * caller already holds the position it asked about. What the shape means for
 * a body is settled once too, in `geometry`, so search reads answers rather
 * than collision boxes; `loadedObservation` is how every producer builds one.
 */
export type BlockObservation =
  | {
      readonly kind: "loaded";
      readonly stateId: number;
      readonly collisionShapes: readonly CollisionBox[];
      readonly traits: BlockTraits;
      readonly geometry: BlockGeometry;
      /** The geometry and the hot traits as one integer of `GEOMETRY_*` and `TRAIT_*` bits, for the predicates search asks of every cell it looks at. */
      readonly bits: number;
    }
  | { readonly kind: "unloaded"; readonly bits: 0 };

export type LoadedBlock = Extract<BlockObservation, { readonly kind: "loaded" }>;

/** The one observation of a cell whose chunk the client does not hold. */
export const UNLOADED: BlockObservation = Object.freeze({ kind: "unloaded", bits: 0 });

/** The shared, immutable observation of one block state, its geometry derived once from its boxes and traits. */
export function loadedObservation(
  stateId: number,
  collisionShapes: readonly CollisionBox[],
  traits: BlockTraits,
): LoadedBlock {
  const geometry = describeBlockGeometry(traits, collisionShapes);
  return Object.freeze({
    kind: "loaded",
    stateId,
    collisionShapes,
    traits,
    geometry,
    bits: observationBits(geometry, traits),
  });
}

/** The identity a door or gate's halves share, or null for a block nothing activates. */
export function activationGroupAt(block: BlockObservation, position: BlockPosition): string | null {
  if (block.kind !== "loaded" || block.traits.activationGroup === null) return null;
  const y = block.traits.upperHalf ? position.y - 1 : position.y;
  return `${block.traits.activationGroup}:${position.x},${y},${position.z}`;
}

export interface WorldChange {
  readonly position: BlockPosition;
  readonly before: BlockObservation;
  readonly after: BlockObservation;
  readonly worldRevision: number;
}

export interface WorldView {
  /**
   * The block at integer coordinates. Three numbers rather than a position
   * object, because search asks hundreds of times per node and must not
   * allocate to ask.
   */
  blockAt(x: number, y: number, z: number): BlockObservation;
  subscribe(listener: (change: WorldChange) => void): () => void;
  readonly revision: number;
}

// ── Cell keys ────────────────────────────────────────────────────────────────
//
// Search touches a cell many times per node, so the key that names a cell in
// a Map or Set is one integer, not a string: x and z in 21 bits each, y in 11,
// packed into the 53 bits a JavaScript number holds exactly. That covers a
// million blocks from the origin on each horizontal axis and heights from
// -512 to 1535, and building one costs three multiplications with no
// allocation. `blockLabel` is the readable form for ids and telemetry.

const HORIZONTAL_OFFSET = 2 ** 20;
const HORIZONTAL_SPAN = 2 ** 21;
const VERTICAL_OFFSET = 512;
const VERTICAL_SPAN = 2 ** 11;
const X_STRIDE = 2 ** 32;
const Y_STRIDE = HORIZONTAL_SPAN;

/** Pack integer coordinates into one exact number; throws outside the packable range. */
export function packKey(x: number, y: number, z: number): number {
  const px = x + HORIZONTAL_OFFSET;
  const py = y + VERTICAL_OFFSET;
  const pz = z + HORIZONTAL_OFFSET;
  if (px < 0 || px >= HORIZONTAL_SPAN || pz < 0 || pz >= HORIZONTAL_SPAN || py < 0 || py >= VERTICAL_SPAN) {
    throw new RangeError(`cell ${x},${y},${z} is outside the packable range`);
  }
  return px * X_STRIDE + py * Y_STRIDE + pz;
}

/** The integer that names this cell in maps and sets. */
export function blockKey(position: BlockPosition): number {
  return packKey(position.x, position.y, position.z);
}

/** The readable `x,y,z` form of a cell, for ids and telemetry. */
export function blockLabel(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

export function blockPosition(position: Position3): BlockPosition {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

export function samePosition(left: BlockPosition, right: BlockPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function offset(position: BlockPosition, x: number, y: number, z: number): BlockPosition {
  return { x: position.x + x, y: position.y + y, z: position.z + z };
}

// ── The player and the entities around it, as one observation ─────────────────
//
// A *revision* is a number or string that changes exactly when something a
// search depends on has changed, so that comparing two revisions answers
// "is this the same question I already asked". The world's counts block
// updates and the resource revision fingerprints the inventory; a goal's is
// defined with the goal, in `goals/goal.ts`. The search identity that guards
// against asking the same question twice is built from all three.

export interface EntityObservation {
  readonly id: number;
  readonly position: Position3;
  readonly width: number;
  readonly height: number;
}

/**
 * What the player is, as distinct from where it is.
 *
 * Sprinting stops below six food, and status effects scale dig time, so both
 * change which movements are physically available and what they cost. The
 * observation carried neither, which left the cost model asserting constants
 * about a player it could not see.
 */
export interface PlayerState {
  readonly food: number;
  readonly effects: Readonly<Record<string, number>>;
  readonly aquaAffinity: boolean;
}

/** Minecraft stops sprinting at or below this food level. */
export const SPRINT_FOOD_MINIMUM = 7;

export interface NavigationObservation {
  readonly player: PlayerState;
  readonly position: Position3;
  readonly dimension: string;
  readonly stance: "supported" | "airborne" | "swimming" | "climbing";
  /** Counts block updates seen so far; a search that read the world at an older one may be stale. */
  readonly worldRevision: number;
  /** Fingerprints the inventory: the blocks and tools in hand decide which routes exist and what they cost. */
  readonly resourceRevision: string;
  /** Item counts by item type. The run counts the scaffold blocks its policy places from here. */
  readonly inventory: ReadonlyMap<number, number>;
  readonly entities: ReadonlyMap<number, EntityObservation>;
}
