export const BOW_DRAW_TICKS = 20;
/** Combat equipment rules shared by the hostile policy and the engagement loop. */
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Position3 } from "../../utils/index.js";

export type CombatLoadout =
  | { readonly kind: "bow"; readonly weapon: Item; readonly shield: Item | null }
  | {
      readonly kind: "melee";
      /** Null means deliberately empty-handed. */
      readonly weapon: Item | null;
      readonly shield: Item | null;
      readonly cooldownTicks: number;
    };

const OFF_HAND_SLOT = 45;
/** An empty hand's attack speed is four attacks per second. */
const EMPTY_HAND_COOLDOWN_TICKS = 5;
/**
 * A full bow draw takes twenty ticks, in which a walking zombie covers about
 * 4.6 blocks. Inside six blocks it reaches melee range before the arrow leaves.
 */
const BOW_MINIMUM_RANGE = 6;
/** Maximum eye-to-body melee reach, shared by ordinary and knockback attacks. */
export const MELEE_RANGE = 3;
/** Prefer weapon families in this order, with their conservative full-strength cooldowns. */
const MELEE_FAMILIES = [
  { name: "sword", cooldownTicks: 13 },
  { name: "axe", cooldownTicks: 25 },
  { name: "pickaxe", cooldownTicks: 17 },
  { name: "shovel", cooldownTicks: 20 },
  { name: "hoe", cooldownTicks: 20 },
] as const;
const TOOL_MATERIALS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"] as const;

/** Both hands first, then inventory. Selection reads this list without changing equipment. */
export function readCombatItems(bot: Pick<Bot, "heldItem" | "inventory">): readonly Item[] {
  return [bot.heldItem, bot.inventory.slots[OFF_HAND_SLOT], ...bot.inventory.items()].filter(
    (item): item is Item => !!item,
  );
}

/** Choose the best material within the first carried weapon family. */
function selectMeleeWeapon(carried: readonly Item[]): { readonly item: Item; readonly cooldownTicks: number } | null {
  for (const family of MELEE_FAMILIES) {
    for (const material of TOOL_MATERIALS) {
      const item = carried.find((item) => item.name === `${material}_${family.name}`);
      if (item) return { item, cooldownTicks: family.cooldownTicks };
    }
  }
  return null;
}

/** A bow is usable only when at least one supported arrow is carried. */
function usableBow(carried: readonly Item[]): Item | null {
  const arrows = carried.some(
    (item) => item.name === "arrow" || item.name === "spectral_arrow" || item.name === "tipped_arrow",
  );
  return arrows ? (carried.find((item) => item.name === "bow") ?? null) : null;
}

/** Choose a weapon and its mechanics from one observation; equipping is a separate effect. */
export function selectCombatLoadout(carried: readonly Item[], targetOffset: Position3): CombatLoadout {
  const shield = carried.find((item) => item.name === "shield") ?? null;
  const bow = usableBow(carried);
  const distance = Math.hypot(targetOffset.x, targetOffset.y, targetOffset.z);
  // Walking closer on this level cannot put an elevated target inside melee
  // range. A carried bow remains usable even inside the ground-melee cutoff.
  if (bow && (distance > BOW_MINIMUM_RANGE || targetOffset.y > MELEE_RANGE))
    return { kind: "bow", weapon: bow, shield };
  return selectMeleeLoadout(carried);
}

/** A stationary firing position may use a bow inside the open-ground approach cutoff. */
export function selectRangedLoadout(carried: readonly Item[]): Extract<CombatLoadout, { kind: "bow" }> | null {
  const weapon = usableBow(carried);
  return weapon ? { kind: "bow", weapon, shield: carried.find((item) => item.name === "shield") ?? null } : null;
}

/** Melee only, including for strikes made during a retreat that cannot stop to draw a bow. */
export function selectMeleeLoadout(carried: readonly Item[]): Extract<CombatLoadout, { kind: "melee" }> {
  const melee = selectMeleeWeapon(carried);
  return {
    kind: "melee",
    weapon: melee?.item ?? null,
    shield: carried.find((item) => item.name === "shield") ?? null,
    cooldownTicks: melee?.cooldownTicks ?? EMPTY_HAND_COOLDOWN_TICKS,
  };
}

/** Whether the bot carries a melee tool or a bow with arrows. Empty-handed fighting is not a weapon. */
export function carriesCombatWeapon(bot: Bot): boolean {
  const carried = readCombatItems(bot);
  return selectMeleeWeapon(carried) !== null || usableBow(carried) !== null;
}

/** Whether the bot can deal damage from beyond a creeper's fuse. */
export function carriesRangedWeapon(bot: Bot): boolean {
  return usableBow(readCombatItems(bot)) !== null;
}

/** Equip the shield first, then the selected weapon; null deliberately empties the hand. */
export async function equipCombatLoadout(bot: Bot, loadout: CombatLoadout): Promise<void> {
  if (loadout.shield && bot.inventory.slots[OFF_HAND_SLOT]?.name !== "shield") {
    await bot.equip(loadout.shield, "off-hand");
  }
  if (loadout.weapon) {
    if (bot.heldItem?.name !== loadout.weapon.name) await bot.equip(loadout.weapon, "hand");
  } else if (bot.heldItem) {
    await bot.unequip("hand");
  }
}
