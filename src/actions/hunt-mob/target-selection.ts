import type { Bot } from "mineflayer";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { isSafeSupport } from "../../navigation/world/block-geometry.js";
import { targetFacts } from "../../survival/perception/combat/target.js";
import { compareTargets } from "../../survival/policy/combat/target-utility.js";
import { COMBAT_APPROACH_RADIUS } from "../../survival/positioning/combat/position.js";

type Entity = Bot["entities"][number];
type DropGround = { kind: "supported"; descent: number } | { kind: "unknown" | "hazard" };

/** A vertical landing estimate, not a promise of loot or a successful pickup route. */
function dropGround(bot: Bot, entity: Entity): DropGround {
  const cell = entity.position.floored();
  // Beyond the engagement's existing approach radius, a landing is unknown
  // for this estimate; a deeper shaft is not evidence of reachable loot.
  for (let y = cell.y; y >= cell.y - COMBAT_APPROACH_RADIUS; y--) {
    const block = bot.blockAt(cell.offset(0, y - cell.y, 0));
    if (!block) return { kind: "unknown" };
    if (["lava", "fire", "soul_fire"].includes(block.name)) return { kind: "hazard" };
    if (block.boundingBox === "block")
      return isSafeSupport(observeMineflayerBlock(block))
        ? { kind: "supported", descent: entity.position.y - y }
        : { kind: "hazard" };
  }
  return { kind: "unknown" };
}

/** Explicit drop hazards stay outside the Enderman distance band; unknown ground remains inspectable. */
export function collectionTargetSafetyTier(bot: Bot, entity: Entity): number {
  return dropGround(bot, entity).kind === "hazard" ? 1 : 0;
}

/** Collection values a recoverable landing; emergency defence keeps its own contact ordering. */
export function compareCollectionTargets(bot: Bot, left: Entity, right: Entity): number {
  const a = dropGround(bot, left);
  const b = dropGround(bot, right);
  const rank = { supported: 0, unknown: 1, hazard: 2 };
  if (a.kind !== b.kind) return rank[a.kind] - rank[b.kind];
  if (a.kind === "supported" && b.kind === "supported" && a.descent !== b.descent) return a.descent - b.descent;
  return compareTargets(targetFacts(bot, left), targetFacts(bot, right));
}
