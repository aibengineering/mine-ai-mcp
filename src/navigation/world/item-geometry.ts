import type { EntityObservation, Position3 } from "./world.js";

/** Whether the player's actual body overlaps the server's item pickup box. */
export function withinItemPickupReach(
  position: Position3,
  item: Pick<EntityObservation, "position" | "width" | "height">,
): boolean {
  const horizontalReach = 0.3 + 1 + item.width / 2;
  return (
    Math.abs(position.x - item.position.x) < horizontalReach &&
    Math.abs(position.z - item.position.z) < horizontalReach &&
    item.position.y < position.y + 1.8 + 0.5 &&
    item.position.y + item.height > position.y - 0.5
  );
}
