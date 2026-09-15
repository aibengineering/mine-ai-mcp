import { Vec3 } from "vec3";
import type { Goal } from "./goal.js";
import { nearGoal } from "./index.js";
import { STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import { USE_RAY_REACH } from "../../world/liquid.js";
import { prepareExcavation, type Dig } from "../movements/excavation.js";
import { stationaryExcavation } from "../movements/stationary-excavation.js";
import { isDry, isHeadPassable, isPassable, isStandableTop, navigationFeet } from "../world/block-geometry.js";
import { obstaclesOf, worldViewRaycaster } from "../world/line-of-sight.js";
import { blockLabel, samePosition, type BlockPosition, type Position3, type WorldView } from "../world/world.js";

type Liquid = "water" | "lava";
const SOURCE_SHAPE = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }];

function dryFooting(world: WorldView, position: Position3): boolean {
  const feet = navigationFeet(position, true);
  const below = world.blockAt(feet.x, feet.y - 1, feet.z);
  const body = world.blockAt(feet.x, feet.y, feet.z);
  const head = world.blockAt(feet.x, feet.y + 1, feet.z);
  return (
    isStandableTop(below) &&
    below.kind === "loaded" &&
    !below.traits.damaging &&
    isDry(body) &&
    isPassable(body) &&
    isDry(head) &&
    isHeadPassable(head)
  );
}

function sourceRay(world: WorldView, position: Position3, source: BlockPosition, liquid: Liquid, eyeHeight: number) {
  const block = world.blockAt(source.x, source.y, source.z);
  if (
    block.kind !== "loaded" ||
    block.traits.liquid !== liquid ||
    !block.traits.liquidSource ||
    position.y + eyeHeight <= source.y + 0.9
  )
    return null;
  const eye = new Vec3(position.x, position.y + eyeHeight, position.z);
  const toward = new Vec3(source.x + 0.5, source.y + 0.9, source.z + 0.5).minus(eye);
  const distance = toward.norm();
  if (distance > USE_RAY_REACH) return null;
  // Empty buckets stop at source liquid too. A nearer source must not be
  // mistaken for an unobstructed ray to the requested, more distant source.
  const ray = worldViewRaycaster((x, y, z) => {
    const cell = world.blockAt(x, y, z);
    return cell.kind === "loaded" && cell.traits.liquid !== null && cell.traits.liquidSource
      ? SOURCE_SHAPE
      : obstaclesOf(cell);
  });
  const hit = ray.raycast(eye, toward.normalize(), distance);
  return hit ? ("position" in hit ? hit.position : hit) : source;
}

/** The actual use precondition, shared by goal planning and the bucket's final observation. */
export function canAccessLiquid(
  world: WorldView,
  position: Position3,
  source: BlockPosition,
  liquid: Liquid,
  eyeHeight = STANDING_EYE_HEIGHT,
): boolean {
  if (!dryFooting(world, position)) return false;
  const hit = sourceRay(world, position, source, liquid, eyeHeight);
  return hit !== null && samePosition(hit, source);
}

/** Reach a source from dry support looking down at it, pricing excavation needed to expose it. */
export function liquidAccessGoal(sources: readonly BlockPosition[], liquid: Liquid): Goal {
  return {
    resolve(observation) {
      if (sources.length === 0) return { kind: "invalid", observation: "No liquid sources were supplied." };
      const approaches = sources.map((source) => nearGoal(source, USE_RAY_REACH).resolve(observation));
      const currentFeet = navigationFeet(observation.position, observation.stance === "supported");
      return {
        kind: "active",
        revision: `liquid-access:${liquid}:${sources.map(blockLabel).join(";")}`,
        heuristic(node) {
          let nearest = Infinity;
          for (const goal of approaches) if (goal.kind === "active") nearest = Math.min(nearest, goal.heuristic(node));
          return nearest;
        },
        isSatisfied(node, world) {
          const current = samePosition(node.feet, currentFeet);
          if (current && observation.stance !== "supported") return false;
          const position = current
            ? observation.position
            : { x: node.feet.x + 0.5, y: node.feet.y, z: node.feet.z + 0.5 };
          if (!dryFooting(world, position)) return false;
          return sources.some((source) => {
            const hit = sourceRay(world, position, source, liquid, STANDING_EYE_HEIGHT);
            return hit !== null && samePosition(hit, source);
          });
        },
        finish(state, context, digContext) {
          const feet = state.node.feet;
          const position = samePosition(feet, currentFeet)
            ? observation.position
            : { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
          if (!dryFooting(state.overlay.view(context.world), position)) return null;
          let best: ReturnType<typeof stationaryExcavation> | null = null;
          for (const source of sources) {
            let overlay = state.overlay;
            const digs: Dig[] = [];
            for (;;) {
              const world = overlay.view(context.world);
              const hit = sourceRay(world, position, source, liquid, STANDING_EYE_HEIGHT);
              if (hit === null) break;
              if (samePosition(hit, source)) {
                const finish = stationaryExcavation(state, {
                  kind: "prepared",
                  digs,
                  breakTicks: digs.reduce((sum, dig) => sum + dig.expectedTicks, 0),
                  breakPenalty: digs.reduce((sum, dig) => sum + dig.penalty, 0),
                });
                if (best === null || finish.cost < best.cost) best = finish;
                break;
              }
              // Open from above, retaining both the pocket's sides and our floor.
              if (hit.y <= source.y || (hit.x === feet.x && hit.z === feet.z && hit.y < feet.y)) break;
              const excavation = prepareExcavation({
                world,
                policy: context.policy,
                position: hit,
                standing: position,
                digContext,
              });
              if (excavation.kind === "unavailable" || excavation.digs.length === 0) break;
              digs.push(...excavation.digs);
              for (const dig of excavation.digs)
                for (const at of [dig.position, ...dig.brings])
                  overlay = overlay.apply({ kind: "break", position: at, stateId: 0 });
            }
          }
          return best;
        },
      };
    },
  };
}
