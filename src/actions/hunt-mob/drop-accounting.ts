import type { Bot, BotEvents } from "mineflayer";
import { DROPPED_ITEM_OBSERVATION_EVENTS } from "../../world/item-pickup.js";
import type { HuntDropSighting } from "./contract.js";

/** Request-lifetime observations, including items appearing while a reflex owns the body.
 * Sightings are not kill attribution, and disappearance does not prove destruction or pickup.
 */
export function observeHuntDrops(bot: Bot, requestedItem: string, lifetime: AbortSignal) {
  const baseline = new Set(Object.keys(bot.entities).map(Number));
  const sightings = new Map<number, HuntDropSighting>();
  const observe = (entity: Bot["entity"]) => {
    let item;
    try {
      item = entity.getDroppedItem();
    } catch {
      return;
    }
    if (!item || item.count <= 0) return;
    // Keep all newly appearing items and requested items already on the ground.
    if (baseline.has(entity.id) && item.name !== requestedItem) return;
    const previous = sightings.get(entity.id);
    sightings.set(entity.id, {
      id: entity.id,
      item: item.name,
      observedCount: item.count,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      blocks: {
        atPosition: bot.blockAt(entity.position)?.name ?? null,
        belowPosition: bot.blockAt(entity.position.offset(0, -1, 0))?.name ?? null,
      },
      observedAt: new Date().toISOString(),
      firstSeen: baseline.has(entity.id) ? "already_loaded" : "during_hunt",
      state: "loaded",
      collectedByBot: previous?.collectedByBot ?? false,
      collectedByOther: previous?.collectedByOther ?? false,
    });
  };
  const collected: BotEvents["playerCollect"] = (collector, entity) => {
    observe(entity);
    const sighting = sightings.get(entity.id);
    if (!sighting) return;
    if (collector.id === bot.entity.id) sighting.collectedByBot = true;
    else sighting.collectedByOther = true;
  };
  const gone: BotEvents["entityGone"] = (entity) => {
    observe(entity);
    const sighting = sightings.get(entity.id);
    if (sighting) sighting.state = "no_longer_observed";
  };
  for (const event of DROPPED_ITEM_OBSERVATION_EVENTS) bot.on(event, observe);
  // A drop can fall into lava between its spawn metadata and its removal.
  bot.on("entityMoved", observe);
  bot.on("playerCollect", collected);
  bot.on("entityGone", gone);
  const close = () => {
    for (const event of DROPPED_ITEM_OBSERVATION_EVENTS) bot.off(event, observe);
    bot.off("entityMoved", observe);
    bot.off("playerCollect", collected);
    bot.off("entityGone", gone);
  };
  lifetime.addEventListener("abort", close, { once: true });
  for (const entity of Object.values(bot.entities)) if (entity.isValid) observe(entity);
  return () => {
    for (const entity of Object.values(bot.entities)) if (entity.isValid) observe(entity);
    return [...sightings.values()].map((sighting) => {
      const entity = bot.entities[sighting.id];
      let loaded = false;
      try {
        loaded = !!entity?.isValid && (entity.getDroppedItem()?.count ?? 0) > 0;
      } catch {
        /* Late metadata. */
      }
      return { ...sighting, state: loaded ? ("loaded" as const) : ("no_longer_observed" as const) };
    });
  };
}
