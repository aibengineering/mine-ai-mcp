import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Vec3 } from "vec3";
import { isSafeSupport, type WorldView } from "../../../navigation/index.js";
import { standingCell } from "./geometry.js";

interface CrystalOpeningSearch {
  readonly world: WorldView;
  readonly columns: readonly { readonly chunkX: number; readonly chunkZ: number }[];
  readonly origin: Vec3;
  readonly target: Vec3;
  readonly receiptRange: number;
  readonly canShoot: (feet: Vec3) => boolean;
  readonly signal: AbortSignal;
  readonly interrupted: () => boolean;
}

/**
 * The caged-crystal playthrough blocked the runtime for over five seconds in
 * findBlocks/useExtraInfo: count=32 bounded results, not millions of block
 * reads and trajectory tests. Scan loaded terrain cooperatively instead.
 * Only feet inside the crystal's explosion-receipt range can be firing sites.
 * Results are route hints; navigation and the eventual shot recheck safety.
 */
export async function findCrystalOpenings(search: CrystalOpeningSearch): Promise<Vec3[] | null> {
  const { world, origin, target, receiptRange, signal, interrupted, canShoot } = search;
  signal.throwIfAborted();
  if (interrupted()) return null;
  const minX = Math.ceil(target.x - receiptRange - 0.5), maxX = Math.floor(target.x + receiptRange - 0.5);
  const minZ = Math.ceil(target.z - receiptRange - 0.5), maxZ = Math.floor(target.z + receiptRange - 0.5);
  const minY = Math.ceil(target.y - receiptRange), maxY = Math.floor(target.y + receiptRange);
  const columns = search.columns.filter(({ chunkX, chunkZ }) =>
    chunkX * 16 <= maxX && chunkX * 16 + 15 >= minX && chunkZ * 16 <= maxZ && chunkZ * 16 + 15 >= minZ);
  // Try nearby columns first, without treating a sampled opening as reachable.
  const distance = ({ chunkX, chunkZ }: (typeof columns)[number]) =>
    Math.max(chunkX * 16 - origin.x, 0, origin.x - (chunkX * 16 + 16)) ** 2 +
    Math.max(chunkZ * 16 - origin.z, 0, origin.z - (chunkZ * 16 + 16)) ** 2;
  columns.sort((a, b) => distance(a) - distance(b));
  const openings: Vec3[] = [];
  let cells = 0, deadline = performance.now() + 8;
  for (const { chunkX, chunkZ } of columns)
    for (let x = Math.max(minX, chunkX * 16); x <= Math.min(maxX, chunkX * 16 + 15); x++)
      for (let z = Math.max(minZ, chunkZ * 16); z <= Math.min(maxZ, chunkZ * 16 + 15); z++)
        for (let y = minY; y <= maxY; y++) {
          // Count cheap reads too: an empty or completely blocked search must
          // still deliver Minecraft packets, heartbeats and cancellation.
          if (++cells >= 256 || performance.now() >= deadline) {
            await yieldToEventLoop();
            signal.throwIfAborted();
            if (interrupted()) return null;
            cells = 0;
            deadline = performance.now() + 8;
          }
          if ((x + 0.5 - target.x) ** 2 + (y - target.y) ** 2 + (z + 0.5 - target.z) ** 2 >= receiptRange ** 2 ||
              !isSafeSupport(world.blockAt(x, y - 1, z))) continue;
          const feet = new Vec3(x, y, z);
          if (standingCell(world, feet) && canShoot(feet.offset(0.5, 0, 0.5))) {
            openings.push(feet);
            if (openings.length === 32)
              return openings.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
          }
        }
  signal.throwIfAborted();
  return interrupted() ? null : openings.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
}
