import type { Bot } from "mineflayer";
import { z } from "zod";

export const recordedLoadoutSchema = z.array(z.tuple([
  z.number().int(), z.string(), z.number().int().positive(), z.number().int().nonnegative(),
]));

/** Restore recorded window slots, counts and durability; untouched slots remain intact. */
export async function restoreRecordedLoadout(bot: Bot, loadout: z.infer<typeof recordedLoadoutSchema>, signal: AbortSignal): Promise<void> {
  const slotName = (slot: number) => {
    const worn: Record<number, string> = { 5: "armor.head", 6: "armor.chest", 7: "armor.legs", 8: "armor.feet", 45: "weapon.offhand" };
    if (worn[slot]) return worn[slot];
    if (slot >= 9 && slot <= 35) return `inventory.${slot - 9}`;
    if (slot >= 36 && slot <= 44) return `hotbar.${slot - 36}`;
    throw new Error(`Invalid recorded inventory slot ${slot}`);
  };
  for (const [slot, name, count, damage] of loadout) {
    signal.throwIfAborted();
    bot.chat(`/item replace entity @s ${slotName(slot)} with minecraft:${name}${damage ? `[minecraft:damage=${damage}]` : ""} ${count}`);
    await bot.waitForTicks(2);
  }
  for (let t = 0; t < 100; t++) {
    signal.throwIfAborted();
    if (loadout.every(([slot, name, count, damage]) => {
      const item = bot.inventory.slots[slot];
      return item?.name === name && item.count === count && (item.durabilityUsed ?? 0) === damage;
    })) return;
    await bot.waitForTicks(1);
  }
  throw new Error("Recorded inventory slots/counts/durability were not acknowledged");
}
