import type { Bot } from "mineflayer";
import { isDrawingBow } from "./attention.js";

type Draw = { entity: Bot["entity"]; active: boolean; started: number | null };
const readers = new WeakMap<Bot, (entity: Bot["entity"]) => number | null>();

/** Unknown starts are already potentially due. This is release timing, not a guaranteed shot. */
export function bowReleaseInTicks(bot: Bot, entity: Bot["entity"]): number | null {
  return readers.get(bot)?.(entity) ?? null;
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
      draws.set(entity.id, { entity, active, started: !active ? null
        : previous?.entity !== entity ? null : !previous.active ? tick : previous.started });
    }
  };
  const advance = () => { tick++; observe(); };
  const gone = (entity: Bot["entity"]) => { draws.delete(entity.id); };
  const clear = () => draws.clear();
  const read = (entity: Bot["entity"]) => {
    const draw = draws.get(entity.id);
    return draw?.entity === entity && draw.active && isDrawingBow(bot, entity) && draw.started !== null
      ? Math.max(0, 20 - (tick - draw.started)) : null;
  };
  observe();
  readers.set(bot, read);
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
  } };
}
