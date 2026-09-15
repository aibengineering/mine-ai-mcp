import type { Bot } from "mineflayer";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import type { TargetFacts } from "../../policy/combat/target-utility.js";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { meleeDistance } from "../../weapons/melee.js";
/** Solid ground immediately below is a preference, never a promise that a drop will be collected. */
export function targetFacts(bot: Bot, entity: Bot["entities"][number], hasHitUs = false): TargetFacts {
  const floor = bot.blockAt(entity.position.offset(0, -0.1, 0));
  return {
    inReach: meleeDistance(bot, entity) <= MELEE_RANGE,
    visible: hasExposedBody(bot, entity),
    hasHitUs,
    safeDropGround:
      floor?.boundingBox === "block" &&
      floor.name !== "magma_block" &&
      floor.name !== "campfire" &&
      floor.name !== "soul_campfire",
    distance: entity.position.distanceTo(bot.entity.position),
  };
}
