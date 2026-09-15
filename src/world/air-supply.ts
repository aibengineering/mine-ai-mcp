import type { Bot } from "mineflayer";

/** Server-owned air in ticks. Missing metadata is unknown, never another entity's oxygenLevel. */
export function airSupplyTicks(bot: Bot): number | null {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  const value: unknown = index < 0 ? undefined : bot.entity?.metadata?.[index];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
