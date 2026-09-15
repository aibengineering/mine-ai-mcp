import { Vec3 } from "vec3";
import type { Position3 } from "../utils/index.js";
import type { CollisionBox } from "../navigation/world/world.js";

export const STANDING_EYE_HEIGHT = 1.62;

/** Mineflayer updates this from the observed pose; standing is the initial pose. */
export function observedEyeHeight(entity: object): number {
  // Mineflayer supplies eyeHeight at runtime; prismarine-entity's types omit it.
  const height: unknown = Reflect.get(entity, "eyeHeight");
  return typeof height === "number" ? height : STANDING_EYE_HEIGHT;
}

/**
 * Whatever can say which block a ray meets first. Mineflayer's live world is
 * one; the planning world's voxel walk in `navigation/world/line-of-sight.ts`
 * is the other, so search and the swing judge visibility by the same rule.
 */
export interface BlockRaycaster {
  /** The cell struck, as Prismarine's block (with `position`) or as bare coordinates. */
  raycast(from: Vec3, direction: Vec3, range: number): { readonly position: Position3 } | Position3 | null;
}

/**
 * A reachable aim point on the block's actual collision shape. Full-cube
 * face centres miss thin carpets; execution must use the point checked here.
 */
export function visibleBlockAim(
  world: BlockRaycaster,
  eye: Position3,
  target: Position3,
  reach: number,
  shapes: readonly CollisionBox[],
): Vec3 | null {
  const start = new Vec3(eye.x, eye.y, eye.z);
  // Prismarine supplies no collision boxes for passable blocks such as cobwebs.
  // Their requested cell can still be dug: aim at its centre only when the ray
  // to that point has no intervening collision. Do not require a ray collision
  // with a target that has no collision shape.
  if (shapes.length === 0) {
    const centre = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    const span = start.distanceTo(centre);
    if (span > reach) return null;
    if (span === 0) return centre;
    const hit = world.raycast(start, centre.minus(start).normalize(), span);
    if (!hit) return centre;
    const position = "position" in hit ? hit.position : hit;
    return position.x === target.x && position.y === target.y && position.z === target.z ? centre : null;
  }
  // Search prices every dig it considers through here, so a face is only
  // spelled out as a vector once a ray has to be cast at it or it is the answer.
  const aimAt = (faceX: number, faceY: number, faceZ: number): Vec3 | null => {
    const dx = faceX - start.x;
    const dy = faceY - start.y;
    const dz = faceZ - start.z;
    const span = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (span > reach) return null;
    const hit = world.raycast(start, new Vec3(dx / span, dy / span, dz / span), reach);
    if (!hit) return null;
    const hitPosition = "position" in hit ? hit.position : hit;
    return hitPosition.x === target.x && hitPosition.y === target.y && hitPosition.z === target.z
      ? new Vec3(faceX, faceY, faceZ)
      : null;
  };
  for (const box of shapes) {
    const centreX = target.x + (box.minX + box.maxX) / 2;
    const centreY = target.y + (box.minY + box.maxY) / 2;
    const centreZ = target.z + (box.minZ + box.maxZ) / 2;
    const halfX = (box.maxX - box.minX) / 2;
    const halfY = (box.maxY - box.minY) / 2;
    const halfZ = (box.maxZ - box.minZ) / 2;
    const facingX = Math.abs(start.x - centreX) > halfX ? Math.sign(start.x - centreX) : 0;
    const facingY = Math.abs(start.y - centreY) > halfY ? Math.sign(start.y - centreY) : 0;
    const facingZ = Math.abs(start.z - centreZ) > halfZ ? Math.sign(start.z - centreZ) : 0;
    // An eye caught inside this collision box can clear the block around it.
    if (facingX === 0 && facingY === 0 && facingZ === 0) return new Vec3(centreX, centreY, centreZ);

    // Match GoalLookAtBlock's face order: y, then x, then z. The ray traversal
    // and collision intersection are the raycaster's; this function only
    // chooses where to aim.
    const face =
      (facingY !== 0 && aimAt(centreX, centreY + facingY * halfY, centreZ)) ||
      (facingX !== 0 && aimAt(centreX + facingX * halfX, centreY, centreZ)) ||
      (facingZ !== 0 && aimAt(centreX, centreY, centreZ + facingZ * halfZ));
    if (face) return face;
  }
  return null;
}
