import { Vec3 } from "vec3";

/**
 * Where things are, and how to name the cell they are in.
 *
 * `Position3` is deliberately structural rather than the `Vec3` class. There is
 * no single `Vec3` class in this dependency tree: Mineflayer and its physics
 * dependencies can resolve different minor versions, and a caret on a `0.x`
 * range pins the minor, so package managers may install both. A `Vec3` from one copy fails `instanceof`
 * against the other, while every copy satisfies this interface. Our own
 * `^0.1.10` is alignment with mineflayer, not staleness — it is where the
 * positions we compare against come from.
 *
 * The rule that follows: accept a `Position3`, return a `Vec3`. Taking the
 * interface makes a function callable with a bot position, an entity position,
 * a block position or a plain object; returning the class gives the caller
 * `offset`, `floored` and `distanceTo`.
 */
export interface Position3 {
  x: number;
  y: number;
  z: number;
}

/** Convert any structural position into this package's Vec3 implementation. */
export function asVec3(position: Position3): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

/**
 * One block cell, as a string that can key a Set or a Map.
 *
 * Floors on the way in, so a precise position and the cell containing it always
 * produce the same key. That matters wherever a bot position, an entity
 * position and a block position are compared to each other — they arrive in
 * different precisions and mean the same cell.
 */
export function cellKey(position: Position3): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;

/** Whether one block cell overlaps the player's standing collision body. */
export function cellIntersectsPlayerBody(cell: Position3, playerPosition: Position3): boolean {
  return cellIntersectsBody(cell, { position: playerPosition, width: PLAYER_WIDTH, height: PLAYER_HEIGHT });
}

/** Whether a block cell intersects an observed body's current dimensions. */
export function cellIntersectsBody(
  cell: Position3,
  body: { readonly position: Position3; readonly width: number; readonly height: number },
): boolean {
  const playerPosition = body.position;
  const halfWidth = body.width / 2;
  return (
    cell.x < playerPosition.x + halfWidth &&
    cell.x + 1 > playerPosition.x - halfWidth &&
    cell.y < playerPosition.y + body.height &&
    cell.y + 1 > playerPosition.y &&
    cell.z < playerPosition.z + halfWidth &&
    cell.z + 1 > playerPosition.z - halfWidth
  );
}
