import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { damagesOnContact } from "../mineflayer/world.js";
import {
  nearestPickupPoint,
  PICKUP_OVERLAP_MARGIN,
  type PickupHazards,
  withinItemPickupReach,
} from "../world/item-geometry.js";
import { horizontalControlsToward } from "./local-steering.js";

/** A second: past a block drop's ten-tick pickup delay, and across a cell even against a current. */
const PICKUP_APPROACH_TICKS = 20;

/**
 * Close on a dropped item from inside the current cell and hold there until
 * the item is taken, and say whether it was or is at least well in reach.
 *
 * A pickup route may arrive in a cell that reaches the item only from part of
 * it, as for a drop in a notch reached from the floor in front, and a body
 * can stop anywhere in its cell: one stopped 0.49 off centre. Judging such an
 * arrival from the cell alone left a coal run just out of reach. This walks
 * toward the nearest point the cell allows and keeps steering there, so a
 * current cannot carry the body back out of reach before the server takes
 * the item. It stops when the item is gone, when the body leaves the ground,
 * or after a bounded number of ticks. The point keeps clear of a neighbour
 * that damages on contact, since the body coasts on past where it releases.
 */
export async function stepIntoPickupReach(
  bot: Bot,
  entityId: number,
  signal?: AbortSignal,
  maximumTicks = PICKUP_APPROACH_TICKS,
): Promise<boolean> {
  const controls = ["forward", "back", "left", "right"] as const;
  const physics = signal ?? new AbortController().signal;
  const feet = bot.entity.position.floored();
  // Lava can arrive beside the cell during the approach, so ask every tick.
  const damaging = (dx: number, dz: number) =>
    [0, 1].some((dy) => {
      const block = bot.blockAt(feet.offset(dx, dy, dz));
      return block !== null && damagesOnContact(block.name);
    });
  const hazards = (): PickupHazards => ({
    west: damaging(-1, 0),
    east: damaging(1, 0),
    north: damaging(0, -1),
    south: damaging(0, 1),
  });
  const observed = () => {
    const entity = bot.entities[entityId];
    return entity?.position ? { position: entity.position, width: entity.width ?? 0.25, height: entity.height ?? 0.25 } : null;
  };
  try {
    for (let tick = 0; tick < maximumTicks; tick += 1) {
      const item = observed();
      if (!item) return true;
      if (!bot.entity.onGround) break;
      const steer = horizontalControlsToward(bot.entity, nearestPickupPoint(feet, item, hazards()), 0.05);
      for (const control of controls) bot.setControlState(control, steer[control]);
      bot.setControlState("sprint", false);
      await waitForPhysicsTicks(bot, 1, physics);
    }
    const item = observed();
    return item === null || withinItemPickupReach(bot.entity.position, item, PICKUP_OVERLAP_MARGIN);
  } finally {
    for (const control of controls) bot.setControlState(control, false);
  }
}
