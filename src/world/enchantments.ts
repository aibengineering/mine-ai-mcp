import type { Bot } from "mineflayer";

export interface Enchantment {
  readonly name: string | null;
  readonly lvl: number;
}

type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

/**
 * The enchantments on a carried item, always as a list.
 *
 * Prismarine-item's `enchants` returns the raw `enchantments` component data
 * for a 1.21 item that carries one: an object holding an `enchantments`
 * array of `{ id, level }`, not the `{ name, lvl }` list its NBT branch
 * returns. Handed to prismarine-block's dig time, that object is iterated and
 * throws "{} is not iterable". The ninth playthrough could not collect a
 * single block from the moment it picked up an enchanted drop.
 */
export function enchantmentsOf(bot: Pick<Bot, "registry">, item: InventoryItem | null | undefined): Enchantment[] {
  if (!item) return [];
  const raw: unknown = item.enchants;
  if (Array.isArray(raw)) return raw as Enchantment[];
  const component = raw as { readonly enchantments?: unknown } | null;
  const entries = component?.enchantments;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry: { readonly id?: number; readonly level?: number }) => ({
    name: typeof entry.id === "number" ? (bot.registry.enchantments[entry.id]?.name ?? null) : null,
    lvl: typeof entry.level === "number" ? entry.level : 0,
  }));
}
