import type { Position3 } from "../../navigation/world/world.js";
import type { BlockPosition, WorldView } from "../../navigation/world/world.js";
import { canReleaseOnObservedGround } from "../../navigation/world/block-geometry.js";

/** An observed lower terrace can catch an impulse after the old attachment
 * floor is lost. Search three blocks below that floor; an involuntary high arc
 * can still hurt on landing, but is not a reason to abandon catching ground. */
export function lowerImpulseLanding(world: WorldView, position: Position3, velocity: Position3, supportY: number): BlockPosition | null {
  for (let y = Math.floor(position.y); y >= supportY - 3; y--) {
    const landing = projectedFooting(position, velocity, y);
    if (canReleaseOnObservedGround(world, { position: landing, velocity, onGround: true }))
      return { x: Math.floor(landing.x), y, z: Math.floor(landing.z) };
    // The uncorrected flight can overlap a broken edge while an adjacent cell
    // still catches the body. Select a nearby supported centre to steer toward;
    // only recover() can establish that the actual landing and coast are safe.
    const nearby: BlockPosition[] = [];
    for (let x = Math.floor(landing.x) - 1; x <= Math.floor(landing.x) + 1; x++)
      for (let z = Math.floor(landing.z) - 1; z <= Math.floor(landing.z) + 1; z++) {
        const centre = { x: x + 0.5, y, z: z + 0.5 };
        if (Math.hypot(centre.x - landing.x, centre.z - landing.z) > 1) continue;
        if (canReleaseOnObservedGround(world, { position: centre, velocity: { x: 0, y: 0, z: 0 }, onGround: true }))
          nearby.push({ x, y, z });
      }
    nearby.sort((a, b) => Math.hypot(a.x + 0.5 - position.x, a.z + 0.5 - position.z) -
      Math.hypot(b.x + 0.5 - position.x, b.z + 0.5 - position.z));
    if (nearby[0]) return nearby[0];
  }
  return null;
}
/** Free flight back to a floor height, using the same gravity and drag as player physics. */
export function projectedFooting(position: Position3, velocity: Position3, floorY: number): Position3 {
  let { x, y, z } = position;
  let { x: vx, y: vy, z: vz } = velocity;
  // A packet's finite upward impulse falls back through floorY under gravity.
  while (y >= floorY) {
    x += vx;
    y += vy;
    z += vz;
    vy = (vy - 0.08) * 0.98;
    vx *= 0.91;
    vz *= 0.91;
  }
  return { x, y: floorY, z };
}
