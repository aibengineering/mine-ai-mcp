import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellIntersectsPlayerBody, type Position3 } from "../utils/index.js";
import { isDryPlacementSite, supportsFlatPlacement } from "./block-classification.js";

const SEARCH_HEIGHTS = [0, -1, 1] as const;

/**
 * Find nearby origins where every footprint cell is clear, supported, and
 * outside the player's body. The footprint is expressed relative to its origin.
 */
export function findFlatPlacementCandidates(bot: Bot, footprint: readonly Position3[], maxRadius = 4): Vec3[] {
  const center = bot.entity.position.floored();
  const candidates: Vec3[] = [];

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;

        for (const dy of SEARCH_HEIGHTS) {
          const origin = center.offset(dx, dy, dz);
          const cells = footprint.map((offset) => origin.offset(offset.x, offset.y, offset.z));
          const valid = cells.every((cell) => {
            if (cellIntersectsPlayerBody(cell, bot.entity.position)) return false;
            return (
              isDryPlacementSite(bot.blockAt(cell)) && supportsFlatPlacement(bot.blockAt(cell.offset(0, -1, 0)))
            );
          });
          if (valid) candidates.push(origin);
        }
      }
    }
  }

  return candidates.sort((left, right) => bot.entity.position.distanceTo(left) - bot.entity.position.distanceTo(right));
}
