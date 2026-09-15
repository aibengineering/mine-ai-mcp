/**
 * A block raycast over a planning world: which cell an eye ray meets first.
 *
 * Search decides where a dig can be made from, so it needs the same answer the
 * client's crosshair gives — not Mineflayer's, which reads the live world, but
 * one over the overlay that already holds the digs planned before this one. A
 * voxel walk from the eye, stopping at the first collision box the ray enters;
 * fluids and unshaped blocks are walked through, as Prismarine's raycast does.
 * An unloaded cell stops the ray: nothing can be seen through the unknown.
 */
import type { BlockRaycaster } from "../../world/block-visibility.js";
import type { BlockObservation, CollisionBox } from "./world.js";

/** What a ray can strike in one cell: its boxes, none for a cell it passes through, or null when the cell is unloaded. */
export type ObstacleLookup = (x: number, y: number, z: number) => readonly CollisionBox[] | null;

export const NO_OBSTACLE: readonly CollisionBox[] = Object.freeze([]);

/** The collision a ray meets in a cell holding `block`. */
export function obstaclesOf(block: BlockObservation): readonly CollisionBox[] | null {
  if (block.kind === "unloaded") return null;
  return block.traits.empty || block.traits.liquid !== null ? NO_OBSTACLE : block.collisionShapes;
}

/**
 * Distance along the ray to the nearest of these boxes, or null when the ray
 * misses them all: the slab test, one axis at a time, narrowing the interval
 * of the ray that lies inside the box.
 */
export function boxEntry(
  boxes: readonly CollisionBox[],
  cell: { x: number; y: number; z: number },
  from: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): number | null {
  let nearest: number | null = null;
  let entry = 0;
  let exit = 0;
  let missed = false;
  const narrow = (min: number, max: number, origin: number, along: number) => {
    if (along === 0) {
      if (origin < min || origin > max) missed = true;
      return;
    }
    const near = (min - origin) / along;
    const far = (max - origin) / along;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
  };
  for (const box of boxes) {
    entry = Number.NEGATIVE_INFINITY;
    exit = Number.POSITIVE_INFINITY;
    missed = false;
    narrow(cell.x + box.minX, cell.x + box.maxX, from.x, direction.x);
    if (missed) continue;
    narrow(cell.y + box.minY, cell.y + box.maxY, from.y, direction.y);
    if (missed) continue;
    narrow(cell.z + box.minZ, cell.z + box.maxZ, from.z, direction.z);
    if (missed) continue;
    const hit = Math.max(entry, 0);
    if (exit < hit) continue;
    if (nearest === null || hit < nearest) nearest = hit;
  }
  return nearest;
}

/** How far along a ray the next cell boundary on one axis lies, and how far each boundary after it. */
function firstBoundary(from: number, cell: number, direction: number): number {
  return direction === 0 ? Number.POSITIVE_INFINITY : Math.abs((cell + (direction > 0 ? 1 : 0) - from) / direction);
}

function boundarySpacing(direction: number): number {
  return direction === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / direction);
}

/**
 * Ray blocks over `obstacles` the way Prismarine rays its world, for the
 * face-selection rules in `block-visibility.ts`. Search casts a ray per dig
 * it prices, so the walk keeps its state in locals and allocates only the
 * cell it reports.
 */
export function worldViewRaycaster(obstacles: ObstacleLookup): BlockRaycaster {
  return {
    raycast(from, direction, range) {
      const cell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
      const stepX = Math.sign(direction.x);
      const stepY = Math.sign(direction.y);
      const stepZ = Math.sign(direction.z);
      const deltaX = boundarySpacing(direction.x);
      const deltaY = boundarySpacing(direction.y);
      const deltaZ = boundarySpacing(direction.z);
      let nextX = firstBoundary(from.x, cell.x, direction.x);
      let nextY = firstBoundary(from.y, cell.y, direction.y);
      let nextZ = firstBoundary(from.z, cell.z, direction.z);
      for (;;) {
        const boxes = obstacles(cell.x, cell.y, cell.z);
        if (boxes === null) return { position: cell };
        if (boxes.length > 0) {
          const entry = boxEntry(boxes, cell, from, direction);
          if (entry !== null) return entry <= range ? { position: cell } : null;
        }
        const travelled = Math.min(nextX, nextY, nextZ);
        if (travelled > range) return null;
        if (nextX === travelled) {
          cell.x += stepX;
          nextX += deltaX;
        } else if (nextY === travelled) {
          cell.y += stepY;
          nextY += deltaY;
        } else {
          cell.z += stepZ;
          nextZ += deltaZ;
        }
      }
    },
  };
}
