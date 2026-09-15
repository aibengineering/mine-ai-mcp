import type { Goal } from "./goal.js";
import { nearGoal } from "./index.js";
import { DIG_REACH, prepareExcavation } from "../movements/excavation.js";
import { stationaryExcavation } from "../movements/stationary-excavation.js";
import { blockLabel, type BlockPosition } from "../world/world.js";
import { waterMiningStance } from "../world/water.js";

/** Reaching a block is not completion: search must also pay for its excavation. */
export function excavateGoal(target: BlockPosition): Goal {
  const approach = nearGoal(target, DIG_REACH);
  return {
    resolve: (observation) => {
      const spatial = approach.resolve(observation);
      if (spatial.kind === "invalid") return spatial;
      return {
        kind: "active",
        revision: `excavate:${blockLabel(target)}`,
        heuristic: spatial.heuristic,
        isSatisfied: () => false,
        finish(state, context, digContext) {
          const feet = state.node.feet;
          // A stationary completion keeps its support. Underfoot excavation is
          // already a priced downward movement in the catalogue.
          if (target.x === feet.x && target.z === feet.z && target.y < feet.y) return null;
          if (
            Math.abs(target.x - feet.x) > DIG_REACH ||
            Math.abs(target.z - feet.z) > DIG_REACH ||
            Math.abs(target.y - feet.y - 1) > DIG_REACH
          )
            return null;
          const world = state.overlay.view(context.world);
          const body = world.blockAt(feet.x, feet.y, feet.z);
          // A dry target can still be slow or impossible to dig from a current.
          // Choose a stable stance; the mining process owns flow isolation.
          if (body.kind === "loaded" && body.traits.liquid === "water" &&
            !waterMiningStance((x, y, z) => world.blockAt(x, y, z), feet, digContext.onGround)) return null;
          const excavation = prepareExcavation({
            world,
            policy: context.policy,
            position: target,
            standing: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
            digContext,
          });
          if (excavation.kind === "unavailable") return null;
          return stationaryExcavation(state, excavation);
        },
      };
    },
  };
}
