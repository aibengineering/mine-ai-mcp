import type { Bot } from "mineflayer";
import { bowDrawAimedAtBot, isDrawingBow } from "./attention.js";

type Draw = { entity: Bot["entity"]; active: boolean; started: number | null; aimedAtBot: boolean };
const readers = new WeakMap<Bot, (entity: Bot["entity"]) => number | null>();
const aimReaders = new WeakMap<Bot, (entity: Bot["entity"]) => boolean>();
/** How far a reported head may stray from the bot's bearing while a draw seen aimed at the bot stays for it. */
const HELD_AIM_TOLERANCE = (30 * Math.PI) / 180;

/** Unknown starts are already potentially due. This is release timing, not a guaranteed shot. */
export function bowReleaseInTicks(bot: Bot, entity: Bot["entity"]): number | null {
  return readers.get(bot)?.(entity) ?? null;
}

/**
 * A draw seen aimed at this bot is still for it while the head stays near the
 * bot's bearing. A skeleton aims its arrow at its target as it stands at
 * release, whatever its head shows, and the head the server reports lags a
 * walking body: at 3.5 blocks it fell 10 degrees behind, outside the narrow
 * aim test, two ticks before the arrow left (skeleton-arena-crossfire,
 * xfire-fix3 t00017). A head turned well away is following another target.
 */
export function bowDrawHeldOnBot(bot: Bot, entity: Bot["entity"]): boolean {
  if (!aimReaders.get(bot)?.(entity)) return false;
  const yaw: unknown = Reflect.get(entity, "headYaw");
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return false;
  const bearing = Math.atan2(-(bot.entity.position.x - entity.position.x), -(bot.entity.position.z - entity.position.z));
  return Math.abs(Math.atan2(Math.sin(yaw - bearing), Math.cos(yaw - bearing))) <= HELD_AIM_TOLERANCE;
}

/** Observe metadata transitions independently of how frequently combat decisions read them. */
export function trackBowDraws(bot: Bot): Disposable {
  const draws = new Map<number, Draw>();
  let tick = 0;
  const observe = () => {
    for (const entity of Object.values(bot.entities)) {
      if (!["skeleton", "stray", "bogged"].includes(entity.name ?? "")) continue;
      const previous = draws.get(entity.id);
      const index = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("living_entity_flags") ?? 8;
      const flags: unknown = entity.metadata?.[index];
      if (typeof flags !== "number") continue;
      // Equipment may arrive after metadata. That must not manufacture a new draw start.
      const active = (flags & 1) !== 0;
      const continuing = active && previous?.entity === entity && previous.active;
      draws.set(entity.id, { entity, active, started: !active ? null
        : previous?.entity !== entity ? null : !previous.active ? tick : previous.started,
        aimedAtBot: active && ((continuing && previous.aimedAtBot) || bowDrawAimedAtBot(bot, entity)) });
    }
  };
  const advance = () => { tick++; observe(); };
  const gone = (entity: Bot["entity"]) => { draws.delete(entity.id); };
  const clear = () => draws.clear();
  const current = (entity: Bot["entity"]) => {
    const draw = draws.get(entity.id);
    return draw?.entity === entity && draw.active && isDrawingBow(bot, entity) ? draw : null;
  };
  const read = (entity: Bot["entity"]) => {
    const draw = current(entity);
    return draw && draw.started !== null ? Math.max(0, 20 - (tick - draw.started)) : null;
  };
  const aimed = (entity: Bot["entity"]) => current(entity)?.aimedAtBot ?? false;
  observe();
  readers.set(bot, read);
  aimReaders.set(bot, aimed);
  bot.on("physicsTick", advance);
  bot.on("entityUpdate", observe);
  bot.on("entityGone", gone);
  bot.on("respawn", clear);
  return { [Symbol.dispose]() {
    bot.off("physicsTick", advance);
    bot.off("entityUpdate", observe);
    bot.off("entityGone", gone);
    bot.off("respawn", clear);
    if (readers.get(bot) === read) readers.delete(bot);
    if (aimReaders.get(bot) === aimed) aimReaders.delete(bot);
  } };
}
