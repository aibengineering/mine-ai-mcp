import type { Bot, BotEvents } from "mineflayer";
import { STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import type { HostileContext } from "../control/combat/context.js";
import { isThreat } from "../perception/combat/threats.js";
import { MELEE_RANGE, selectMeleeLoadout } from "./equipment.js";
import { hasSweepBystander, meleeDistance } from "./melee.js";

/**
 * Strike reachable threats with the current hand while navigation owns movement.
 * No aiming, equipping, or movement controls run from this observer: a dig or
 * placement must keep its hand, and turning toward a pursuer would steer the
 * escape back into it. Mineflayer's attack targets the observed entity directly.
 */
export function defendWhileRetreating(bot: Bot, context: HostileContext, signal: AbortSignal) {
  let ticks = 0;
  let nextSwing = 0;
  let attacks = 0;
  const weapons = new Set<string>();
  const struck = new Set<number>();
  const killed = new Set<number>();
  const onDeath: BotEvents["entityDead"] = (entity) => {
    if (struck.has(entity.id)) killed.add(entity.id);
  };
  const tick = () => {
    ticks += 1;
    if (
      context.policy?.melee === false ||
      signal.aborted ||
      bot.health <= 0 ||
      ticks < nextSwing ||
      bot.targetDigBlock ||
      bot.usingHeldItem
    )
      return;
    const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
    const targets = Object.values(bot.entities)
      .filter((entity) => isThreat(bot, entity, context))
      .filter((entity) => meleeDistance(bot, entity) <= MELEE_RANGE)
      .sort((a, b) => meleeDistance(bot, a) - meleeDistance(bot, b));
    for (const target of targets) {
      const toward = target.position.offset(0, target.height / 2, 0).minus(eye);
      const distance = toward.norm();
      if (distance > 0 && bot.world.raycast(eye, toward.scaled(1 / distance), distance)) continue;
      if (bot.heldItem?.name.endsWith("_sword") && hasSweepBystander(bot, target)) continue;
      const loadout = selectMeleeLoadout(bot.heldItem ? [bot.heldItem] : []);
      bot.attack(target);
      attacks += 1;
      struck.add(target.id);
      weapons.add(bot.heldItem?.name ?? "hand");
      nextSwing = ticks + loadout.cooldownTicks;
      break;
    }
  };
  bot.on("physicsTick", tick);
  bot.on("entityDead", onDeath);
  return {
    evidence: () => ({ attacks, weaponsUsed: [...weapons], killedTargetIds: [...killed] }),
    [Symbol.dispose]() {
      bot.off("physicsTick", tick);
      bot.off("entityDead", onDeath);
    },
  };
}
