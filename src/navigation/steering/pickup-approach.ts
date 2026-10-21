import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { nearestPickupPoint, withinItemPickupReach } from "../world/item-geometry.js";
import { horizontalControlsToward } from "./local-steering.js";

/** Long enough to cross most of a cell at walking speed, about four ticks a block. */
const PICKUP_APPROACH_TICKS = 10;

/**
 * Close on a dropped item from inside the current cell until the body's
 * pickup box overlaps it, and say whether it does.
 *
 * A pickup route may arrive in a cell that reaches the item only from part of
 * it, as for a drop in a notch reached from the floor in front, and a body
 * can stop anywhere in its cell: one stopped 0.49 off centre. Judging such an
 * arrival from the cell alone left a coal run just out of reach. This walks
 * toward the nearest point the cell allows and stops when the box overlaps,
 * when the body leaves the ground, or after a bounded number of ticks.
 */
export async function stepIntoPickupReach(
  bot: Bot,
  entityId: number,
  signal?: AbortSignal,
  maximumTicks = PICKUP_APPROACH_TICKS,
): Promise<boolean> {
  const controls = ["forward", "back", "left", "right"] as const;
  const physics = signal ?? new AbortController().signal;
  try {
    for (let tick = 0; ; tick += 1) {
      const entity = bot.entities[entityId];
      if (!entity?.position) return false;
      const item = { position: entity.position, width: entity.width ?? 0.25, height: entity.height ?? 0.25 };
      if (withinItemPickupReach(bot.entity.position, item)) return true;
      if (tick >= maximumTicks || !bot.entity.onGround) return false;
      const feet = bot.entity.position.floored();
      const steer = horizontalControlsToward(bot.entity, nearestPickupPoint(feet, item), 0.05);
      for (const control of controls) bot.setControlState(control, steer[control]);
      bot.setControlState("sprint", false);
      await waitForPhysicsTicks(bot, 1, physics);
    }
  } finally {
    for (const control of controls) bot.setControlState(control, false);
  }
}
