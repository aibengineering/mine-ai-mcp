import type { Bot } from "mineflayer";
import type { EventEmitter } from "node:events";
import { snapshotBotStatus, updateBotStatus, type SqlBotData } from "../bot-data/index.js";

/** Long enough to take a window's packet burst or a local slot move as one snapshot. */
export const BOT_STATUS_COALESCE_MS = 250;
/** How stale position, time and the freshness timestamp may get while nothing else changes. */
export const BOT_STATUS_HEARTBEAT_MS = 1_000;

export interface BotStatusTiming {
  readonly coalesceMs: number;
  readonly heartbeatMs: number;
}

/**
 * Keep SQL current without requiring a status tool call. Owned by the runtime.
 * `timing` exists so a caller that cannot wait on the production cadence (a
 * test) can shorten it; the runtime omits it.
 */
export function observeBotStatus(
  bot: Bot,
  data: SqlBotData,
  timing: Partial<BotStatusTiming> = {},
): () => void {
  const coalesceMs = timing.coalesceMs ?? BOT_STATUS_COALESCE_MS;
  const heartbeatMs = timing.heartbeatMs ?? BOT_STATUS_HEARTBEAT_MS;
  let pending: ReturnType<typeof setTimeout> | undefined;
  // currentWindow's generic typings omit the updateSlot event emitted by every window.
  let window: EventEmitter | null = null;
  let lastError: string | null = null;
  const refresh = () => {
    pending = undefined;
    try {
      updateBotStatus(data, snapshotBotStatus(bot));
      lastError = null;
    } catch (error) {
      // A contended database must not throw out of a Mineflayer event handler.
      // The next heartbeat retries; the persisted timestamp remains stale.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) process.stderr.write(`[bot-status] ${message}\n`);
      lastError = message;
    }
  };
  const changed = () => {
    // Coalesce window packet bursts and local slot moves into a complete snapshot.
    pending ??= setTimeout(refresh, coalesceMs);
    pending.unref();
  };
  const watchWindow = () => {
    window?.off("updateSlot", changed);
    window = bot.currentWindow as unknown as EventEmitter | null;
    window?.on("updateSlot", changed);
    changed();
  };
  const events = ["heldItemChanged", "spawn", "respawn", "health", "death"] as const;
  using subscriptions = new DisposableStack();
  bot.inventory.on("updateSlot", changed);
  subscriptions.defer(() => bot.inventory.off("updateSlot", changed));
  for (const event of events) {
    bot.on(event, changed);
    subscriptions.defer(() => bot.off(event, changed));
  }
  for (const event of ["windowOpen", "windowClose"] as const) {
    bot.on(event, watchWindow);
    subscriptions.defer(() => bot.off(event, watchWindow));
  }
  subscriptions.defer(() => {
    window?.off("updateSlot", changed);
    clearTimeout(pending);
  });
  watchWindow();
  // Also refresh position/time and provide a freshness timestamp while idle.
  const heartbeat = setInterval(changed, heartbeatMs);
  heartbeat.unref();
  subscriptions.defer(() => clearInterval(heartbeat));
  const ended = () => owned.dispose();
  bot.once("end", ended);
  subscriptions.defer(() => bot.off("end", ended));
  const owned = subscriptions.move();
  return () => owned.dispose();
}
