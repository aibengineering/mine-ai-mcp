import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import { SupportedPositionHold } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import type { CombatPolicy } from "../policy/combat/contract.js";
import { guardHealthRefusal } from "../policy/combat/health.js";
import { CombatItemUse } from "./item-use.js";
import { projectileShieldFacing } from "./shield-facing.js";

/**
 * Five ready ticks permit about 1.4 blocks of sprint travel; settling on the
 * current cell can add another half block. Warn two blocks before the body
 * crosses a shot, rather than starting readiness at its collision boundary.
 * This is a conservative movement warning, not a larger physical hitbox.
 */
export const RETREAT_PROJECTILE_ALLOWANCE = 2;

type RetreatGuardResult = { kind: "finished" } | { kind: "stopped"; reason: string };

/** Share guard admission with its release boundary so an unfit guard cannot stop another escape. */
export function retreatGuardLimit(bot: Bot, policy: Readonly<CombatPolicy>): string | null {
  const health = guardHealthRefusal(bot.health, policy);
  if (health) return health;
  if (bot.inventory.slots[45]?.name !== "shield") return "Stationary projectile guard lost its equipped shield.";
  return null;
}

/** A settled retreat can turn its shield toward incoming fire before resuming its route. */
export async function guardRetreatProjectiles(
  bot: Bot,
  navigation: NavigationRuntime,
  signal: AbortSignal,
  deadline: number,
  policy: Readonly<CombatPolicy>,
  escapeRequired: () => boolean = () => false,
): Promise<RetreatGuardResult> {
  const footing = new SupportedPositionHold(bot, navigation.world);
  const tick = () => footing.tick();
  const face = async () => {
    const facing = projectileShieldFacing(bot, RETREAT_PROJECTILE_ALLOWANCE);
    if (facing) await bot.lookAt(facing, true);
  };
  const itemUse = new CombatItemUse(bot, async (ticks) => {
    for (let held = 0; held < ticks; held++) {
      if (signal.aborted || escapeRequired()) return;
      await face();
      await waitForPhysicsTicks(bot, 1, signal);
    }
  });
  bot.on("physicsTick", tick);
  try {
    await face();
    return await itemUse.guardUntil<RetreatGuardResult>(() => {
      if (signal.aborted || escapeRequired() || bot.health <= 0 || Date.now() >= deadline) return { kind: "finished" };
      // Unlike an accelerating escape, this guard is stationary. Give the
      // existing reflex policy its body back when holding can no longer work.
      const reason = retreatGuardLimit(bot, policy);
      if (reason) return { kind: "stopped", reason };
      return incomingShieldProjectiles(bot, RETREAT_PROJECTILE_ALLOWANCE).length > 0 ? null : { kind: "finished" };
    });
  } finally {
    try {
      await itemUse.neutralise(() => footing.stop(signal), signal);
    } finally {
      bot.off("physicsTick", tick);
    }
  }
}
