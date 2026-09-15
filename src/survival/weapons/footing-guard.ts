import type { Bot } from "mineflayer";
import type { CombatPolicy } from "../policy/combat/contract.js";
import { fusedThreats, isSwelling } from "../perception/combat/creepers.js";
import { projectileShieldFacing } from "./shield-facing.js";

/** The footing owner can face and use its shield without surrendering steering.
 * Placement may change item use; every recovery step rechecks the real hand. */
export async function guardFooting(bot: Bot, policy: Readonly<CombatPolicy>): Promise<void> {
  if (!policy.shield) { bot.deactivateItem(); return; }
  const shield = bot.inventory.items().find(item => item.name === "shield") ?? bot.inventory.slots[45];
  if (shield?.name !== "shield") return;
  if (bot.inventory.slots[45]?.name !== "shield") await bot.equip(shield, "off-hand");
  const creeper = [...fusedThreats(bot, 6)].sort((a, b) => Number(isSwelling(bot, b)) - Number(isSwelling(bot, a)) ||
    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  const facing = creeper ? creeper.position.offset(0, 1, 0) : projectileShieldFacing(bot);
  if (facing) await bot.lookAt(facing, true);
  if (!bot.usingHeldItem) bot.activateItem(true);
}
