import type { Bot } from "mineflayer";
import { harvestTier, snapshotTools, type ToolClass, type ToolSnapshotEntry } from "./tool-tiers.js";

export interface ToolTierLoss {
  readonly class: ToolClass;
  readonly before: ToolSnapshotEntry;
  readonly now: ToolSnapshotEntry;
  readonly reason: string;
}

const materialRank: Record<ToolSnapshotEntry["tier"], number> = {
  none: 0, other: 1, wooden: 2, leather: 2, golden: 3, chainmail: 3,
  stone: 4, turtle: 4, iron: 5, diamond: 6, netherite: 7,
};

function toolClass(name: string): ToolClass | null {
  for (const kind of ["pickaxe", "shovel", "axe", "hoe", "sword"] as const) {
    if (name === kind || name.endsWith(`_${kind}`)) return kind;
  }
  return null;
}

/**
 * Stop at the navigator/process safe boundary when a tool class actually
 * selected for a break loses material tier, harvest capability, or its last
 * carried item. Inventory classes merely carried by the bot are irrelevant.
 */
export function observeToolTierLoss(bot: Bot): {
  signal: AbortSignal;
  loss: () => ToolTierLoss | null;
  select: (itemType: number | null) => void;
  close: () => void;
} {
  const controller = new AbortController();
  const initial = new Map(snapshotTools(bot).tools.map((entry) => [entry.class, entry]));
  const relevant = new Set<ToolClass>();
  let loss: ToolTierLoss | null = null;
  let inspectionScheduled = false;
  let closed = false;
  const inspect = () => {
    if (closed || loss) return;
    const current = new Map(snapshotTools(bot).tools.map((entry) => [entry.class, entry]));
    for (const kind of relevant) {
      const before = initial.get(kind)!;
      const now = current.get(kind)!;
      if (!before.item) continue;
      const capabilityFell = harvestTier(bot, now.item ?? "") < harvestTier(bot, before.item);
      const materialFell = materialRank[now.tier] < materialRank[before.tier];
      if (now.item && !capabilityFell && !materialFell) continue;
      const position = bot.entity?.position?.floored?.() ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 };
      const remaining = now.item ? `${now.tier} ${kind} remains` : `no ${kind} remains`;
      const reason = `[TOOL_TIER_LOST] ${before.item} was lost at ${position.x},${position.y},${position.z}; ${remaining}.`;
      loss = { class: kind, before, now, reason };
      controller.abort(reason);
      return;
    }
  };
  const scheduleInspect = () => {
    if (inspectionScheduled) return;
    inspectionScheduled = true;
    queueMicrotask(() => {
      inspectionScheduled = false;
      inspect();
    });
  };
  const select = (itemType: number | null) => {
    if (itemType === null) return;
    const kind = toolClass(bot.registry.items[itemType]?.name ?? "");
    if (kind) relevant.add(kind);
  };
  bot.inventory.on?.("updateSlot", scheduleInspect);
  bot.on?.("heldItemChanged", scheduleInspect);
  return {
    signal: controller.signal,
    loss: () => loss,
    select,
    close: () => {
      closed = true;
      bot.inventory.off?.("updateSlot", scheduleInspect);
      bot.off?.("heldItemChanged", scheduleInspect);
    },
  };
}
