import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { cellKey } from "../utils/index.js";

const registry = minecraftData("1.21.4");

/**
 * Fake worlds for tests, built from a map of named cells.
 *
 * Every rule in `world/` reads the world through a function from cell to block,
 * so that is what this produces. Each test names only the cells it cares about;
 * everything else is air, or stone at and below `groundY` when one is given.
 * The name `void` is a cell the bot cannot see, which is how an unloaded chunk
 * reaches the rules under test.
 */

export const FULL_CUBE = [[0, 0, 0, 1, 1, 1]];
export const SLAB = [[0, 0, 0, 1, 0.5, 1]];
export const NO_SHAPE: number[][] = [];

/** Blocks whose collision shape is not a full cube, by name. */
const SHAPES: Record<string, number[][]> = {
  air: NO_SHAPE,
  cave_air: NO_SHAPE,
  torch: NO_SHAPE,
  // A fluid has no collision shape, which is why a block raycast walks through
  // one — and why a full bucket's pour lands past it.
  water: NO_SHAPE,
  lava: NO_SHAPE,
  fire: NO_SHAPE,
  soul_fire: NO_SHAPE,
  oak_slab: SLAB,
};

export interface FakeBlock {
  name: string;
  position: Vec3;
  stateId: number;
  shapes: number[][];
  boundingBox: string;
  getProperties: () => Record<string, unknown>;
}

export interface WorldOptions {
  /** Solid stone at this level and below. Omit for a world of open air. */
  groundY?: number | null;
  /** Called with every cell the rule under test reads, to assert on its cost. */
  onRead?: (cell: Vec3) => void;
}

export type CellReader = (cell: Vec3) => FakeBlock | null;

export function worldOf(named: Record<string, string>, { groundY = null, onRead }: WorldOptions = {}): CellReader {
  return (cell) => {
    onRead?.(cell);
    const name = named[cellKey(cell)];
    if (name === "void") return null;
    if (name) return blockOf(name, cell);
    if (groundY !== null && cell.y <= groundY) return blockOf("stone", cell);
    return blockOf("air", cell);
  };
}

function blockOf(name: string, cell: Vec3): FakeBlock {
  const shapes = SHAPES[name] ?? FULL_CUBE;
  return {
    name,
    position: cell,
    stateId: registry.blocksByName[name]?.defaultState ?? 0,
    shapes,
    boundingBox: shapes.length > 0 ? "block" : "empty",
    getProperties: () => ({}),
  };
}

/**
 * Prismarine's block raycast over a fake world: a voxel walk that stops at the
 * first cell `solid` accepts, reporting the face it entered through in
 * Prismarine's own index order (bottom, top, north, south, west, east).
 *
 * Real rather than approximate because the rules that use it — which face the
 * eye can see, where a pour would land — are about which cell the ray meets
 * first and from which side, and a stepping fake gets both subtly wrong.
 * A cell with no collision shape, which is every fluid, is walked through.
 */
export function raycastThrough(
  solid: (cell: Vec3) => boolean,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): { position: Vec3; face: number; intersect: Vec3 } | null {
  const cell = origin.floored();
  const step = { x: Math.sign(direction.x), y: Math.sign(direction.y), z: Math.sign(direction.z) };
  const delta = (axis: "x" | "y" | "z") =>
    direction[axis] === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / direction[axis]);
  const boundary = (axis: "x" | "y" | "z") =>
    direction[axis] === 0
      ? Number.POSITIVE_INFINITY
      : Math.abs((cell[axis] + (direction[axis] > 0 ? 1 : 0) - origin[axis]) / direction[axis]);
  const next = { x: boundary("x"), y: boundary("y"), z: boundary("z") };
  let face = -1;
  let travelled = 0;
  for (;;) {
    if (solid(cell)) return { position: cell.clone(), face, intersect: origin.plus(direction.scaled(travelled)) };
    travelled = Math.min(next.x, next.y, next.z);
    if (travelled > maxDistance) return null;
    if (next.x === travelled) {
      cell.x += step.x;
      next.x += delta("x");
      face = step.x > 0 ? 4 : 5;
    } else if (next.y === travelled) {
      cell.y += step.y;
      next.y += delta("y");
      face = step.y > 0 ? 0 : 1;
    } else {
      cell.z += step.z;
      next.z += delta("z");
      face = step.z > 0 ? 2 : 3;
    }
  }
}
