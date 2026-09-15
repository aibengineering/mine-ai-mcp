import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { preferredScaffoldItem } from "../../../navigation/mineflayer/movement-policy.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { findPlacementSupport, occupiedCell } from "../../../world/placement.js";
import type { CreeperObservation } from "../../perception/combat/creepers.js";

/** One supported block on an exposed blast-to-body segment. This is partial
 * protection, not a claim of enclosure or permission to stop observing fuses. */
export function blastBarrierCells(bot: Bot, threats: readonly CreeperObservation[]): Vec3[] {
  const cells = new Map<string, Vec3>();
  for (const threat of threats.filter(t => t.observed && t.distance <= 6).sort((a, b) => a.distance - b.distance)) {
    for (const height of [0.5, 1.5]) {
      const body = bot.entity.position.offset(0, height, 0);
      const blast = threat.position.offset(0, 0.1, 0);
      const segment = blast.minus(body);
      const length = segment.norm();
      // A pre-existing block already protects this segment; do not thicken it.
      if (length < 0.01 || bot.world.raycast(body, segment.scaled(1 / length), length)) continue;
      for (let distance = 0.75; distance < Math.min(length, 3); distance += 0.25) {
        const cell = body.plus(segment.scaled(distance / length)).floored();
        if (cells.has(cell.toString()) || occupiedCell(bot, cell)) continue;
        const block = bot.blockAt(cell);
        const support = findPlacementSupport(bot, cell);
        if (!block || !isReplaceableForPlacement(block) || !support) continue;
        const face = support.support.position.offset(0.5 + support.face.x / 2, 0.5 + support.face.y / 2, 0.5 + support.face.z / 2);
        if (face.distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 4.5) cells.set(cell.toString(), cell);
      }
    }
  }
  return [...cells.values()];
}

export function blastBarrierMaterial(bot: Bot) {
  return preferredScaffoldItem(bot);
}
