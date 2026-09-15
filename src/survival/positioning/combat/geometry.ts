import { Vec3 } from "vec3";
import { isHeadPassable, isPassable, isSafeSupport } from "../../../navigation/world/block-geometry.js";
import { obstaclesOf, worldViewRaycaster } from "../../../navigation/world/line-of-sight.js";
import type { CollisionBox, WorldView } from "../../../navigation/world/world.js";
import { clearCombatRay } from "../../../world/entity-geometry.js";

const CUBE: readonly CollisionBox[] = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }];

export interface CombatPositionPlan {
  readonly protected: Vec3;
  readonly fighting: Vec3;
  readonly corner: Vec3;
  /** Initially the fighting cell; later peeks can move one step beyond this preserved opening. */
  readonly entrance: Vec3;
  readonly placements: readonly Vec3[];
}

export function standingBody(cell: Vec3) {
  return { position: cell.offset(0.5, 0, 0.5), width: 0.6, height: 1.8 };
}

export function standingCell(world: WorldView, cell: Vec3): boolean {
  return (
    isSafeSupport(world.blockAt(cell.x, cell.y - 1, cell.z)) &&
    isPassable(world.blockAt(cell.x, cell.y, cell.z)) &&
    isHeadPassable(world.blockAt(cell.x, cell.y + 1, cell.z))
  );
}

function positionRays(world: WorldView, added: ReadonlySet<string>) {
  return worldViewRaycaster((x, y, z) =>
    added.has(new Vec3(x, y, z).toString()) ? CUBE : obstaclesOf(world.blockAt(x, y, z)),
  );
}

/** Unlike protection, a usable opening needs positive evidence all the way to its target. */
export function clearPlannedRay(world: WorldView, placements: readonly Vec3[], from: Vec3, to: Vec3): boolean {
  return clearCombatRay(positionRays(world, new Set(placements.map((cell) => cell.toString()))), from, to);
}

export function positionWorld(world: WorldView, placements: readonly Vec3[] = []) {
  const added = new Set(placements.map((cell) => cell.toString()));
  const rays = positionRays(world, added);
  return {
    raycast: (from: Vec3, direction: Vec3, range: number) => {
      const hit = rays.raycast(from, direction, range);
      if (!hit) return null;
      const cell = "position" in hit ? hit.position : hit;
      // Search stops at unknown terrain. Protection needs positive evidence of
      // a wall, so an unloaded obstruction instead counts as possible exposure.
      return added.has(new Vec3(cell.x, cell.y, cell.z).toString()) ||
        world.blockAt(cell.x, cell.y, cell.z).kind === "loaded"
        ? hit
        : null;
    },
  };
}
