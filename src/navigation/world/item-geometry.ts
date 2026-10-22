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
 * How much further from a damaging neighbour the body's edge keeps. A walk
 * released inside its brake still coasts: one closing on a drop beside lava
 * released at 0.08 a tick and slid 0.03 past its point into the lava.
 */
export const PICKUP_HAZARD_CLEARANCE = 0.2;

/** The faces of a stance cell whose neighbour the body must stay clear of. */
export interface PickupHazards {
  readonly west: boolean;
  readonly east: boolean;
  readonly north: boolean;
  readonly south: boolean;
}

const NO_HAZARDS: PickupHazards = Object.freeze({ west: false, east: false, north: false, south: false });

/**
 * Where in a stance cell the body comes nearest an item without leaving the
 * cell: its centre moved toward the item and kept a body's half width inside,
 * and a further clearance from any face whose neighbour damages on contact.
 */
export function nearestPickupPoint(
  feet: BlockPosition,
  item: Pick<EntityObservation, "position">,
  hazards: PickupHazards = NO_HAZARDS,
): Position3 {
  const clamp = (value: number, low: number, lowHazard: boolean, highHazard: boolean) =>
    Math.min(
      Math.max(value, low + BODY_HALF_WIDTH + (lowHazard ? PICKUP_HAZARD_CLEARANCE : 0)),
      low + 1 - BODY_HALF_WIDTH - (highHazard ? PICKUP_HAZARD_CLEARANCE : 0),
    );
  return {
    x: clamp(item.position.x, feet.x, hazards.west, hazards.east),
    y: feet.y,
    z: clamp(item.position.z, feet.z, hazards.north, hazards.south),
  };
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
