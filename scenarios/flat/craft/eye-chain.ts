import { createRequire } from "node:module";
import type { Item } from "prismarine-item";
import { craftItem } from "../../../src/actions/craft-item/craft-item.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ navigation, bot, signal, log }) => {
  const ItemCodec = (createRequire(import.meta.url)("prismarine-item") as (registry: object) => typeof Item)(
    bot.registry,
  );
  const readSnapshot = () => {
    signal.throwIfAborted();
    return new Promise<{ empty: boolean; counts: Record<string, number> }>((resolve, reject) => {
      const cleanup = () => {
        bot._client.off("window_items", onItems);
        signal.removeEventListener("abort", onAbort);
        bot.off("end", onEnd);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("Disconnected before fixture inventory observation"));
      };
      const onItems = (packet: { windowId: number; items: object[]; carriedItem: object }) => {
        if (packet.windowId !== 0) return;
        const slots = packet.items.map((item) => ItemCodec.fromNotch(item));
        const counts: Record<string, number> = {};
        for (const item of slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd)) {
          if (item) counts[item.name] = (counts[item.name] ?? 0) + item.count;
        }
        cleanup();
        resolve({
          empty: !ItemCodec.fromNotch(packet.carriedItem) && slots.slice(0, 5).every((item) => !item),
          counts,
        });
      };
      bot._client.on("window_items", onItems);
      signal.addEventListener("abort", onAbort, { once: true });
      bot.once("end", onEnd);
      try {
        // Fixture-only observation after execution: a stale click outside the
        // slots requests server inventory state without picking up an item.
        bot._client.write("window_click", {
          windowId: 0,
          stateId: -1,
          slot: -1,
          mouseButton: 0,
          mode: 0,
          changedSlots: [],
          cursorItem: ItemCodec.toNotch(null),
        });
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });
  };
  const result = await craftItem(bot, navigation, { items: [{ itemName: "ender_eye", count: 6 }] }, { signal });
  await bot.waitForTicks(10);
  const authoritative = await readSnapshot();
  const counts = authoritative.counts;
  const passed =
    result.status === "succeeded" &&
    authoritative.empty &&
    counts.ender_eye === 6 &&
    counts.ender_pearl === 1 &&
    !counts.blaze_rod &&
    !counts.blaze_powder;
  const detail = JSON.stringify({ result, authoritative, passed });
  log(detail);
  return { status: passed ? "succeeded" : "failed", detail };
};
