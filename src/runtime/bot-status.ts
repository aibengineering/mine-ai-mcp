import type { Bot } from "mineflayer";
import type { EventEmitter } from "node:events";
import { snapshotBotStatus, updateBotStatus, type SqlBotData } from "../bot-data/index.js";

/** Keep SQL current without requiring a status tool call. Owned by the runtime. */
export function observeBotStatus(bot: Bot, data: SqlBotData): () => void {
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
    pending ??= setTimeout(refresh, 250);
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
  const heartbeat = setInterval(changed, 1_000);
  heartbeat.unref();
  subscriptions.defer(() => clearInterval(heartbeat));
  const ended = () => owned.dispose();
  bot.once("end", ended);
  subscriptions.defer(() => bot.off("end", ended));
  const owned = subscriptions.move();
  return () => owned.dispose();
}
