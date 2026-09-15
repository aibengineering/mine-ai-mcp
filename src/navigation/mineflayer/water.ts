import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "./world.js";
import { waterOccupancy } from "../world/water.js";
import { UNLOADED, type BlockPosition } from "../world/world.js";
import { admitsDive } from "../world/swimming.js";

/** Public destination admission uses the same water geometry as route search. */
export function canOccupyWater(bot: Bot, feet: BlockPosition): boolean {
  if (bot.blockAt(new Vec3(feet.x, feet.y, feet.z))?.name !== "water") return false;
  const read = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block === null ? UNLOADED : observeMineflayerBlock(block);
  };
  const occupancy = waterOccupancy(read, feet.x, feet.y, feet.z);
  // Public geometry asks whether a full-air approach could work. Runtime uses live air.
  return occupancy === "submerged" ? admitsDive(read, feet, { origin: feet, airTicks: 300 }) : occupancy !== "unavailable";
}
