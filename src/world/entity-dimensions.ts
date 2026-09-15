import type { Bot } from "mineflayer";

type Entity = Parameters<Bot["attack"]>[0];

/** Mineflayer leaves slime and magma-cube dimensions at their registry base size. */
export function entityDimensions(bot: Bot, entity: Entity): { width: number; height: number } {
  if (entity.name === "slime" || entity.name === "magma_cube") {
    const data = bot.registry.entitiesByName[entity.name]!;
    const index = data.metadataKeys!.indexOf("size");
    const size: unknown = entity.metadata[index];
    if (typeof size === "number" && size > 0) return { width: data.width! * size, height: data.height! * size };
  }
  return { width: entity.width, height: entity.height };
}
