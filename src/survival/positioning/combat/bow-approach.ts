import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Goal } from "../../../navigation/index.js";
import { obstaclesOf, worldViewRaycaster } from "../../../navigation/world/line-of-sight.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { bowTrajectory, clearBowTrajectory } from "../../weapons/bow-trajectory.js";
import { standingCell } from "./geometry.js";

/** Reach an actual firing line; a hovering target need not have a melee stance. */
export function bowApproachGoal(bot: Bot, targetId: number, aim: () => Vec3): Goal {
  return {
    resolve() {
      if (!bot.entities[targetId]?.isValid)
        return { kind: "invalid", observation: `Entity ${targetId} is not currently observed.` };
      const target = aim();
      return {
        kind: "active",
        revision: `bow:${targetId}:${target}`,
        // Search the nearest usable opening rather than closing to sword reach.
        heuristic: () => 0,
        isSatisfied({ feet }, world) {
          const cell = new Vec3(feet.x, feet.y, feet.z);
          if (!standingCell(world, cell)) return false;
          const trajectory = bowTrajectory(cell.offset(0.5, STANDING_EYE_HEIGHT - 0.1, 0.5), target);
          const rays = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z)));
          return (
            trajectory !== null &&
            clearBowTrajectory(trajectory, (from, direction, distance) => rays.raycast(from, direction, distance))
          );
        },
      };
    },
  };
}
