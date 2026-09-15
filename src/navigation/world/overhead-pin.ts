/**
 * A body held under a block it does not fit beneath.
 *
 * Minecraft gives a player three poses: standing at 1.8 blocks, crouching at
 * 1.5, and swimming or crawling at 0.6. The server picks the tallest that fits
 * where the player is, so a player under a slab, a trapdoor, or a big dripleaf
 * that has reset above them is quietly crouched, and every position the client
 * then reports with a taller body is a collision the server refuses and sends
 * back. Mineflayer's physics knows one body, 1.8 blocks tall, so from its side
 * the bot rises a few hundredths of a block every tick, is put back, and never
 * moves in any direction however its controls are set. Observed live on
 * 2026-09-12: a hunt fell through a tilting big dripleaf into a one-deep pool,
 * the leaf reset flat above it, and the bot was held at the leaf's underside
 * less the crouch height for the rest of the request while navigation retried
 * the same step from the same cell. `scenarios/flat/hunt/dripleaf-pool-trap.yaml`
 * reproduces it.
 *
 * The condition is read from geometry rather than from the packet stream: the
 * 1.8-block column over the feet overlaps a collision box that begins above
 * the crawling pose, so the server has somewhere shorter to keep the player
 * and the client has not. In ordinary movement the client's own physics keeps
 * the body out of every box, so the overlap is itself the evidence that the
 * two physics disagree. The cell holding the box is what has to be broken for
 * the body to stand up.
 */
import type { BlockPosition, Position3, WorldView } from "./world.js";

const STANDING_HEIGHT = 1.8;
/** The shortest pose the server can keep a player in; a box below this is a floor or a wall, not a ceiling. */
const CRAWLING_HEIGHT = 0.6;
const HALF_WIDTH = 0.3;

/** The cell whose collision holds a standing body down at `position`, or null when the body fits where it is. */
export function overheadPinningCell(world: WorldView, position: Position3): BlockPosition | null {
  const top = position.y + STANDING_HEIGHT;
  const clearance = position.y + CRAWLING_HEIGHT;
  const feetY = Math.floor(position.y);
  const minX = position.x - HALF_WIDTH;
  const maxX = position.x + HALF_WIDTH;
  const minZ = position.z - HALF_WIDTH;
  const maxZ = position.z + HALF_WIDTH;
  for (let y = feetY; y <= feetY + 2; y += 1)
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x += 1)
      for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z += 1) {
        const block = world.blockAt(x, y, z);
        if (block.kind !== "loaded") continue;
        for (const box of block.collisionShapes) {
          const bottom = y + box.minY;
          if (bottom <= clearance || bottom >= top) continue;
          if (x + box.maxX <= minX || x + box.minX >= maxX || z + box.maxZ <= minZ || z + box.minZ >= maxZ) continue;
          return { x, y, z };
        }
      }
  return null;
}
