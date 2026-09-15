import type { Bot } from "mineflayer";
import { recordEvent, type SqlBotData } from "../bot-data/index.js";

type Stack = { slot: number; name: string; used: number; maximum: number; warned: boolean };
const worn = { 5: "head", 6: "chest", 7: "legs", 8: "feet", 45: "off_hand" } as const;
// Vanilla LivingEntity.handleEntityEvent: status 47..52 names the broken slot.
const breakSlots: Record<number, number> = { 48: 45, 49: 5, 50: 6, 51: 7, 52: 8 };

/** Low-volume inventory notices, independent of which action owns the bot. */
export function observeEquipmentEvents(bot: Bot, data: SqlBotData): () => void {
  let stacks: Stack[] = [];
  let pending = false;
  let disposed = false;
  // Preserve the last equipped name if inventory removal precedes break status.
  const equipped = new Map<number, Stack>();
  const hand = () => 36 + bot.quickBarSlot;
  const location = (slot: number) => slot === hand() ? "main_hand" as const
    : worn[slot as keyof typeof worn] ?? "inventory" as const;
  const snapshot = (): Stack[] => Object.entries(bot.inventory.slots).flatMap(([key, item]) => {
    const slot = Number(key);
    if (!item || slot < 5 || slot > 45) return [];
    const maximum = item.maxDurability, used = item.durabilityUsed;
    return Number.isInteger(maximum) && maximum > 0 && Number.isInteger(used) && used >= 0
      ? [{ slot, name: item.name, used, maximum, warned: false }] : [];
  });
  const scan = () => {
    pending = false;
    if (disposed) return;
    const next = snapshot();
    const unmatched = new Set(stacks);
    const matches = new Map<Stack, Stack>();
    // Match unchanged stacks first, so swapping identical tools does not give
    // the worn tool the fresh tool's warning state. Slot updates are batched.
    for (const item of next) {
      const previous = [...unmatched].find(old => old.name === item.name && old.maximum === item.maximum && old.used === item.used);
      if (previous) { matches.set(item, previous); unmatched.delete(previous); }
    }
    for (const item of next) {
      const previous = matches.get(item) ?? [...unmatched].find(old => old.slot === item.slot && old.name === item.name && old.maximum === item.maximum);
      if (previous) unmatched.delete(previous);
      const remaining = Math.max(0, item.maximum - item.used);
      item.warned = remaining / item.maximum <= 0.25 && (previous?.warned ?? false);
      if (remaining > 0 && remaining / item.maximum <= 0.25 && !item.warned) {
        recordEvent(data, bot.username, {
          type: "equipment_low_durability", observedAt: new Date().toISOString(),
          summary: `${item.name} durability low: ${Math.ceil(remaining / item.maximum * 100)}% left (${remaining}/${item.maximum}).`,
          payload: { item: item.name, slot: item.slot, location: location(item.slot), remaining, maximum: item.maximum },
        });
        item.warned = true;
      }
      if (item.slot === hand() || item.slot in worn) equipped.set(item.slot, { ...item });
    }
    stacks = next;
  };
  const changed = () => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(scan);
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity?.id) return;
    const slot = packet.entityStatus === 47 ? hand() : breakSlots[packet.entityStatus];
    if (slot === undefined) return;
    const item = snapshot().find(item => item.slot === slot) ?? equipped.get(slot);
    recordEvent(data, bot.username, {
      type: "equipment_broken", observedAt: new Date().toISOString(),
      summary: `${item?.name ?? location(slot).replaceAll("_", " ") + " equipment"} broke.`,
      payload: { item: item?.name ?? null, slot, location: location(slot), remaining: 0, maximum: item?.maximum ?? null },
    });
    equipped.delete(slot);
  };
  const onRespawn = () => { equipped.clear(); changed(); };
  bot.inventory.on("updateSlot", changed);
  bot.on("heldItemChanged", changed);
  bot.on("respawn", onRespawn);
  bot._client?.on("entity_status", onStatus);
  scan();
  return () => {
    disposed = true;
    bot.inventory.off("updateSlot", changed);
    bot.off("heldItemChanged", changed);
    bot.off("respawn", onRespawn);
    bot._client?.off("entity_status", onStatus);
  };
}
