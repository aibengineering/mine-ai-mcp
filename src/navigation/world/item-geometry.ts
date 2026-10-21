import type { BlockPosition, EntityObservation, Position3 } from "./world.js";

/**
 * Whether the player's actual body overlaps the server's item pickup box,
 * horizontally by at least `margin`.
 */
export function withinItemPickupReach(
  position: Position3,
  item: Pick<EntityObservation, "position" | "width" | "height">,
  margin = 0,
): boolean {
  const horizontalReach = 0.3 + 1 + item.width / 2 - margin;
  return (
    Math.abs(position.x - item.position.x) < horizontalReach &&
    Math.abs(position.z - item.position.z) < horizontalReach &&
    item.position.y < position.y + 1.8 + 0.5 &&
    item.position.y + item.height > position.y - 0.5
  );
}

/** Half the player's width: how close the body's centre can come to a cell's edge. */
const BODY_HALF_WIDTH = 0.3;

/**
 * Where in a stance cell the body comes nearest an item without leaving the
 * cell: its centre moved toward the item and kept a body's half width inside.
 */
export function nearestPickupPoint(
  feet: BlockPosition,
  item: Pick<EntityObservation, "position">,
): Position3 {
  const clamp = (value: number, low: number) =>
    Math.min(Math.max(value, low + BODY_HALF_WIDTH), low + 1 - BODY_HALF_WIDTH);
  return { x: clamp(item.position.x, feet.x), y: feet.y, z: clamp(item.position.z, feet.z) };
}

/**
 * How far into the pickup box a body closing on an item must get. The server
 * judges a tick behind the client, and a current pushes back between ticks:
 * an overlap of 0.02 at a waterfall oak was never a pickup.
 */
export const PICKUP_OVERLAP_MARGIN = 0.15;

/** Whether a body standing in `feet` can bring the item well into pickup reach without leaving the cell. */
export function stanceReachesItem(
  feet: BlockPosition,
  item: Pick<EntityObservation, "position" | "width" | "height">,
): boolean {
  return withinItemPickupReach(nearestPickupPoint(feet, item), item, PICKUP_OVERLAP_MARGIN);
}
