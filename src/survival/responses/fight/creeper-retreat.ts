/** Physical escape consumes connection-owned observations and reports its actual limit. */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { CreeperClearance, CREEPER_CLEARANCE } from "../../perception/combat/creepers.js";
import { creeperRetreatHeading } from "../../positioning/combat/creeper-retreat.js";
export type CreeperRetreatOutcome = "finished" | "blocked" | "expired" | "interrupted";

export async function retreatFromCreepers(
  bot: Bot, signal: AbortSignal, stopped: () => boolean,
  observation?: { clearance: CreeperClearance; tick(): number; dead: ReadonlySet<number> },
): Promise<CreeperRetreatOutcome> {
  signal.throwIfAborted();
  const clearance = observation?.clearance ?? new CreeperClearance(bot);
  const dead = observation?.dead ?? new Set<number>();
  let ticks = 0;
  const read = () => clearance.observe(observation?.tick() ?? ticks, dead);
  clearance.require(read().filter(threat => threat.distance <= 16));
  using controls = new DisposableStack();
  controls.defer(() => bot.setControlState("sprint", false));
  controls.defer(() => bot.setControlState("forward", false));
  bot.setControlState("sprint", true);
  bot.setControlState("forward", true);
  let committed: Vec3 | null = null;
  for (; ticks < 90; ticks++) {
    if (stopped()) return "interrupted";
    const nearby = read();
    clearance.require(nearby.filter(threat => threat.distance <= CREEPER_CLEARANCE));
    if (!clearance.pending) return "finished";
    const heading = creeperRetreatHeading(bot, nearby, committed, dead);
    if (!heading) return "blocked";
    committed = heading;
    await bot.lookAt(bot.entity.position.offset(0, bot.entity.height, 0).plus(heading.scaled(4)), true);
    await waitForPhysicsTicks(bot, 1, signal);
  }
  return "expired";
}
