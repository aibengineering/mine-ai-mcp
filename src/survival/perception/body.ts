import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { airSupplyTicks } from "../../world/air-supply.js";
import { lavaLevel } from "../../world/lava-flow.js";
export function isBurning(bot: Bot): boolean {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("shared_flags") ?? -1;
  const flags: unknown = bot.entity.metadata?.[index];
  return typeof flags === "number" && (flags & 1) !== 0;
}

export function fireAt(bot: Bot, cell: Vec3): boolean {
  const name = bot.blockAt(cell)?.name;
  return name === "fire" || name === "soul_fire";
}

/** Active fire contact is different from the residual burning metadata flag. */
export function fireContactCells(bot: Bot): Vec3[] {
  const p = bot.entity.position;
  const radius = (bot.entity.width ?? 0.6) / 2;
  const inset = 0.001;
  const cells: Vec3[] = [];
  for (let x = Math.floor(p.x - radius + inset); x <= Math.floor(p.x + radius - inset); x++)
    for (let z = Math.floor(p.z - radius + inset); z <= Math.floor(p.z + radius - inset); z++)
      for (let y = Math.floor(p.y + inset); y <= Math.floor(p.y + (bot.entity.height ?? 1.8) - inset); y++) {
        const cell = new Vec3(x, y, z);
        if (fireAt(bot, cell)) cells.push(cell);
      }
  return cells;
}

export function isInFire(bot: Bot): boolean {
  return fireContactCells(bot).length > 0;
}

export function isInLava(bot: Bot): boolean {
  if (Reflect.get(bot.entity, "isInLava") === true) return true;
  // Mineflayer contracts its swimming box by 0.1 horizontally and 0.4
  // vertically. The server still burns a body brushing lava from soul sand.
  const p = bot.entity.position;
  const radius = (bot.entity.width ?? 0.6) / 2;
  const inset = 0.001; // Exclude faces which merely touch at a block boundary.
  const bottom = p.y + inset;
  for (let x = Math.floor(p.x - radius + inset); x <= Math.floor(p.x + radius - inset); x++)
    for (let z = Math.floor(p.z - radius + inset); z <= Math.floor(p.z + radius - inset); z++)
      for (let y = Math.floor(bottom); y <= Math.floor(p.y + (bot.entity.height ?? 1.8) - inset); y++) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (block?.name !== "lava") continue;
        const level = lavaLevel(block);
        // A source or falling stream is 8/9 high; another lava cell above
        // fills this one to its top. Flowing levels progressively lower it.
        const height = bot.blockAt(new Vec3(x, y + 1, z))?.name === "lava" ? 1 : (8 - (level >= 8 ? 0 : level)) / 9;
        if (bottom < y + height) return true;
      }
  return false;
}
export function isInWater(bot: Bot): boolean {
  return Reflect.get(bot.entity, "isInWater") === true;
}
/** Air is back when the bar reads full again; it refills in a second or two once the head is out. */
export const FULL_AIR_POINTS = 20;

export function airSupplyPoints(bot: Bot): number | null {
  const ticks = airSupplyTicks(bot);
  return ticks === null ? null : Math.round(ticks / 15);
}
