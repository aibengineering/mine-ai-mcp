import type { Bot } from "mineflayer";
import { acknowledgeEndCredits } from "./world/procedures/end-credits.js";
import { observeDamageRegistry } from "./world/watchers/damage-registry.js";

/**
 * Mineflayer creation options every Mine AI MCP bot shares.
 *
 * Mineflayer replays the physics ticks it missed while the event loop was
 * busy, up to four per 50 ms interval, from an accumulator it never bounds.
 * Two Nether exploration captures on 8 September 2026 ran at 70 ticks per
 * second for their whole 20 s window, the bot moving at three and a half
 * times normal speed; and inside every burst the route executor's step
 * handoff, which resolves between ticks, left the finished step's controls
 * driving the remaining ticks of the burst. One tick per interval drops a
 * stalled tick instead of replaying it.
 */
export const BOT_PHYSICS_OPTIONS = { maxCatchupTicks: 1 } as const;

/**
 * Install the bot observers Mine AI MCP needs before login.
 *
 * Navigation is not among them: it is not a Mineflayer plugin, and the session
 * constructs its runtime explicitly. Neither is `mineflayer-tool`, which this
 * once loaded for a tool check nothing called; it also loaded the upstream
 * `mineflayer-pathfinder`, a second pathfinder whose tick listeners ran beside
 * ours. Collection prices tools through navigation's `evaluateBreak`.
 */
export function loadBotPlugins(bot: Bot): void {
  observeDamageRegistry(bot);
  acknowledgeEndCredits(bot);
}
