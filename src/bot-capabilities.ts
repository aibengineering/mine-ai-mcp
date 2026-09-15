import type { Bot } from "mineflayer";
import { plugin as toolPlugin, type Tool } from "mineflayer-tool";
import { observeDamageRegistry } from "./world/damage-registry.js";

export type BotTool = Pick<Tool, "equipForBlock">;

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
 * Install the physical bot plugins Mine AI MCP needs.
 *
 * Navigation is not among them: it is not a Mineflayer plugin, and the session
 * constructs its runtime explicitly.
 */
export function loadBotPlugins(bot: Bot): void {
  observeDamageRegistry(bot);
  if (!botTool(bot)) bot.loadPlugin(toolPlugin);
}

function botTool(bot: Bot): BotTool | null {
  const tool = (bot as Bot & { tool?: Partial<BotTool> }).tool;
  return typeof tool?.equipForBlock === "function" ? tool : null;
}

/** Return the exact Tool capability Collect uses, or explain the host defect. */
export function requireBotTool(bot: Bot): BotTool {
  const tool = botTool(bot);
  if (!tool) {
    throw new Error("Collect Block requires the mineflayer-tool plugin.");
  }
  return tool;
}

/** Verify ambient plugin typings against the capabilities installed at runtime. */
export function assertBotPluginsLoaded(bot: Bot): void {
  requireBotTool(bot);
}
