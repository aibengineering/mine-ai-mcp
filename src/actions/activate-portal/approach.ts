import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { createMovements, nearGoal, type Navigate, type Goal } from "../../navigation/index.js";
import { useItemAt } from "../../world/index.js";
import type { Position3 } from "../../utils/index.js";
import type { ActionContext } from "../action.js";

export interface ActivatePortalDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly useItem: typeof useItemAt;
}

/** Three feet-to-block blocks leave room for eye height within vanilla's 4.5-block use reach. */
const APPROACH_RANGE = 3;

export async function approachPortalBlock(
  bot: Bot,
  target: Vec3,
  permits: (feet: Position3) => boolean,
  context: ActionContext,
  dependencies: ActivatePortalDependencies,
): Promise<string | null> {
  context.signal?.throwIfAborted();
  const ready = () =>
    bot.entity.position.floored().distanceTo(target) <= APPROACH_RANGE && permits(bot.entity.position);
  if (ready()) return null;
  const near = nearGoal(target, APPROACH_RANGE);
  const goal: Goal = {
    resolve(observation) {
      const resolved = near.resolve(observation);
      if (resolved.kind !== "active") return resolved;
      return {
        ...resolved,
        isSatisfied: (node, world) => {
          // Judge our current column at the actual body position: its cell
          // centre can be outside while the player's edge still overlaps.
          const currentColumn =
            node.feet.x === Math.floor(observation.position.x) && node.feet.z === Math.floor(observation.position.z);
          const feet = currentColumn
            ? observation.position
            : { x: node.feet.x + 0.5, y: node.feet.y, z: node.feet.z + 0.5 };
          return resolved.isSatisfied(node, world) && permits(feet);
        },
      };
    },
  };
  try {
    const route = await dependencies.navigate({
      movements: dependencies.createMovements(bot, { protectedBlockNames: ["obsidian", "end_portal_frame"] }),
      goal,
      signal: context.signal,
    });
    context.signal?.throwIfAborted();
    if (route.status === "stopped") return `[PORTAL_UNREACHABLE] ${route.reason}`;
    return ready() ? null : "[PORTAL_UNREACHABLE] Bot did not arrive within use reach at a permitted position.";
  } catch (cause) {
    context.signal?.throwIfAborted();
    return `[PORTAL_UNREACHABLE] ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}
