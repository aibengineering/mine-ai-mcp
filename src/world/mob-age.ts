import type { Bot } from "mineflayer";

export const MOB_AGES = ["adult", "baby", "unknown", "not_applicable"] as const;
export type MobAge = (typeof MOB_AGES)[number];

/** Read the registered baby flag; vanilla omits its default false value on spawn. */
export function observeMobAge(bot: Pick<Bot, "registry">, entity: Pick<Bot["entity"], "name" | "metadata">): MobAge {
  const keys = entity.name ? bot.registry.entitiesByName[entity.name]?.metadataKeys : undefined;
  if (!keys) return "unknown";
  const index = keys.indexOf("baby");
  if (index < 0) return "not_applicable";
  if (!entity.metadata) return "unknown";
  const baby: unknown = entity.metadata[index];
  if (baby === true) return "baby";
  if (baby === false || baby === undefined) return "adult";
  return "unknown";
}
