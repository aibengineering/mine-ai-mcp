import type { BlockPosition, Position3, WorldView } from "./world.js";
import { isSafeSupport } from "./block-geometry.js";
export interface WaterLanding {
  readonly cell: BlockPosition;
  readonly ticks: number;
  readonly drop: number;
}
/**
 * Deliberately admits full safe floors with open air above; partial/waterlogged supports need separate qualification.
 *
 * A waterloggable floor is refused because the pour never reaches the cell: a
 * bucket aimed at the top face of leaves, a slab or stairs fills that block
 * instead of placing a source above it, and the body lands dry on a floor that
 * still stops it. A live 32-block bucket drop onto oak leaves was fatal.
 */
export function waterableLanding(world: Pick<WorldView, "blockAt">, cell: BlockPosition): boolean {
  const floor = world.blockAt(cell.x, cell.y - 1, cell.z);
  const feet = world.blockAt(cell.x, cell.y, cell.z);
  const head = world.blockAt(cell.x, cell.y + 1, cell.z);
  return floor.kind === "loaded" && floor.geometry.fullCube && isSafeSupport(floor) &&
    !floor.traits.waterlogged && !floor.traits.waterloggable && !floor.traits.falling &&
    feet.kind === "loaded" && feet.traits.empty && feet.traits.liquid === null && !feet.traits.waterlogged && !feet.traits.damaging &&
    head.kind === "loaded" && head.traits.empty && head.traits.liquid === null && !head.traits.waterlogged && !head.traits.damaging;
}
/** Conservative swept body clearance: a wall or partial ledge invalidates the free-flight forecast. */
function clearBodySweep(world: Pick<WorldView, "blockAt">, from: Position3, to: Position3): boolean {
  for (let x = Math.floor(Math.min(from.x, to.x) - 0.299); x <= Math.floor(Math.max(from.x, to.x) + 0.299); x++)
    for (let z = Math.floor(Math.min(from.z, to.z) - 0.299); z <= Math.floor(Math.max(from.z, to.z) + 0.299); z++)
      for (let y = Math.floor(Math.min(from.y, to.y) + 0.001); y <= Math.floor(Math.max(from.y, to.y) + 1.799); y++) {
        const block = world.blockAt(x, y, z);
        if (block.kind === "unloaded" || block.collisionShapes.length || block.traits.liquid || block.traits.damaging) return false;
      }
  return true;
}
/** Forecast the unpowered body, using Mineflayer's post-physics velocity (the next tick's displacement). */
export function predictWaterLanding(position: Position3, velocity: Position3, world: Pick<WorldView, "blockAt">): WaterLanding | null {
  let { x, y, z } = position;
  let vx = velocity.x, vy = velocity.y, vz = velocity.z;
  let peak = y;
  for (let ticks = 1; ticks <= 100; ticks++) {
    const from = { x, y, z };
    const nextY = y + vy;
    x += vx;
    z += vz;
    if (vy < 0)
      for (let floorY = Math.floor(y); floorY >= Math.floor(nextY) - 1; floorY--) {
        if (floorY + 1 > y + 0.001 || floorY + 1 < nextY - 0.001)
          continue;
        // A raised block touching the body's edge can stop the fall above the
        // centre column. Include horizontal arrival: native step resolution
        // can catch a corner entered later in the same falling tick.
        const contacts: BlockPosition[] = [];
        for (let fx = Math.floor(Math.min(from.x, x) - 0.299); fx <= Math.floor(Math.max(from.x, x) + 0.299); fx++)
          for (let fz = Math.floor(Math.min(from.z, z) - 0.299); fz <= Math.floor(Math.max(from.z, z) + 0.299); fz++) {
            const floor = world.blockAt(fx, floorY, fz);
            if (floor.kind === "unloaded") return null;
            if (floor.collisionShapes.length || floor.traits.liquid)
              contacts.push({ x: fx, y: floorY + 1, z: fz });
          }
        if (contacts.length) {
          // The source must still overlap the body after horizontal motion.
          // Prefer the centre column when several equally high floors fit.
          const cell = contacts.filter(cell =>
            cell.x + 1 > x - 0.299 && cell.x < x + 0.299 &&
            cell.z + 1 > z - 0.299 && cell.z < z + 0.299 && waterableLanding(world, cell),
          ).sort((a, b) =>
            (a.x + 0.5 - x) ** 2 + (a.z + 0.5 - z) ** 2 -
            ((b.x + 0.5 - x) ** 2 + (b.z + 0.5 - z) ** 2),
          )[0];
          return cell && clearBodySweep(world, from, { x, y: cell.y, z }) ? { cell, ticks, drop: peak - cell.y } : null;
        }
      }
    if (!clearBodySweep(world, from, { x, y: nextY, z })) return null;
    y = nextY;
    peak = Math.max(peak, y);
    vx *= 0.91;
    vz *= 0.91;
    vy = (vy - 0.08) * 0.98;
  }
  return null;
}
