import { isHeadPassable, isSafeSupport } from "./block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "./world.js";

// Measured on our pinned 1.21.4 physics: sink .025, rise .175 blocks/tick.
// Include acceleration and centring, rather than pricing terminal speed alone.
export const SWIM_DOWN_TICKS = 44;
export const SWIM_UP_TICKS = 10;
export const SWIM_HORIZONTAL_TICKS = 14;
export const DIVE_RESERVE_TICKS = 65;
export const DIVE_BACKSTOP_TICKS = 25;

/** A loaded ascent column. Its bottom may be one newly excavated pickup cell. */
export function openWaterSurface(read: WorldView["blockAt"], feet: BlockPosition): BlockPosition | null {
  for (let y = feet.y; y <= feet.y + 32; y++) {
    const body = read(feet.x, y, feet.z);
    const head = read(feet.x, y + 1, feet.z);
    if (body.kind !== "loaded" || head.kind !== "loaded") return null;
    if (body.traits.waterlogged || head.traits.waterlogged) return null;
    const pickupHole = y === feet.y && isSafeSupport(read(feet.x, y - 1, feet.z)) &&
      head.traits.liquid === "water" && head.traits.liquidSource;
    // A mined floor is briefly air before its source-water neighbour flows in.
    // Both observations leave the same one-cell, supported escape corridor.
    if ((!pickupHole && (body.traits.liquid !== "water" || !body.traits.liquidSource)) ||
      (pickupHole && body.traits.liquid !== "water" && (body.traits.liquid !== null || !isHeadPassable(body))) || body.collisionShapes.length > 0) return null;
    if (head.traits.liquid === null && isHeadPassable(head)) return { x: feet.x, y, z: feet.z };
    if (head.traits.liquid !== "water" || !head.traits.liquidSource || head.collisionShapes.length > 0) return null;
  }
  return null;
}

export function swimTravelTicks(from: Position3, to: Position3): number {
  return Math.hypot(to.x - from.x, to.z - from.z) * SWIM_HORIZONTAL_TICKS +
    Math.max(0, from.y - to.y) * SWIM_DOWN_TICKS + Math.max(0, to.y - from.y) * SWIM_UP_TICKS + 8;
}

/** Apply jump early enough to arrest sinking; release early enough to arrest lift. */
export function holdSwimDepth(y: number, velocityY: number, targetY: number): boolean {
  return y + velocityY * 4 < targetY;
}

export interface DiveAdmission {
  readonly origin: Position3;
  readonly airTicks: number;
}

export function admitsDive(read: WorldView["blockAt"], feet: BlockPosition, budget: DiveAdmission, workTicks = 0): boolean {
  const surface = openWaterSurface(read, feet);
  return surface !== null && swimTravelTicks(budget.origin, feet) + workTicks +
    swimTravelTicks(feet, surface) + DIVE_RESERVE_TICKS <= budget.airTicks;
}
