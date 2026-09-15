import { createRequire } from "node:module";
import type { Item } from "prismarine-item";
import { executeCraftPlan } from "../../../src/world/crafting.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, signal, log }) => {
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
  const evidence: string[] = [];
  let passed = true;
  for (const { table, full, itemName } of [
    { table: false, full: true, itemName: "honey_block" },
    { table: false, full: false, itemName: "honey_block" },
    { table: true, full: true, itemName: "honey_block" },
    { table: true, full: false, itemName: "honey_block" },
    { table: true, full: true, itemName: "cake" },
  ]) {
    bot.chat("/clear @s");
    bot.chat("/kill @e[type=minecraft:item]");
    const ingredients: Readonly<Record<string, number>> =
      itemName === "cake"
        ? { cobblestone: 1920, milk_bucket: 3, sugar: 2, egg: 1, wheat: 3 }
        : { cobblestone: full ? 2240 : 2176, honey_bottle: 4 };
    for (const [name, count] of Object.entries(ingredients)) bot.chat(`/give @s ${name} ${count}`);
    await bot.waitForTicks(15);
    const slotsBefore = bot.inventory.items().length;
    const recipe = bot.recipesAll(bot.registry.itemsByName[itemName]!.id, null, table)[0]!;
    const craftingTable = table ? bot.blockAt(bot.entity.position.offset(1, 0, 0).floored()) : null;
    if (table && craftingTable?.name !== "crafting_table") throw new Error("Fixture crafting table missing");
    const dropped = new Map<number, { name: string; count: number }>();
    let mutationClicks = 0;
    const onDrop: Parameters<typeof bot.on<"itemDrop">>[1] = (entity) => {
      const item = entity.getDroppedItem();
      if (item) dropped.set(entity.id, { name: item.name, count: item.count });
    };
    const write = bot._client.write;
    bot._client.write = (name, packet) => {
      if (name === "window_click" && packet.slot >= 0) mutationClicks += 1;
      return write.call(bot._client, name, packet);
    };
    bot.on("itemDrop", onDrop);
    try {
      const result = await executeCraftPlan(bot, [{ recipe, applications: 1 }], craftingTable, signal);
      await bot.waitForTicks(10);
      const snapshot = await readSnapshot();
      const counts = snapshot.counts;
      const refused = full && itemName === "honey_block";
      const expected = refused
        ? result.kind === "failed" &&
          String(result.cause).includes("execution needs inventory room") &&
          mutationClicks === 0 &&
          counts.honey_bottle === 4 &&
          !counts.honey_block
        : result.kind === "completed" &&
          (itemName === "cake"
            ? counts.cake === 1 && counts.bucket === 3 && !counts.milk_bucket
            : counts.honey_block === 1 && counts.glass_bottle === 4 && !counts.honey_bottle);
      const valid = expected && snapshot.empty && dropped.size === 0 && slotsBefore === (full ? 36 : 35);
      passed &&= valid;
      const detail = JSON.stringify({
        table,
        full,
        itemName,
        slotsBefore,
        mutationClicks,
        authoritative: snapshot,
        dropped: [...dropped.values()],
        result: result.kind === "failed" ? { ...result, cause: String(result.cause) } : result,
        passed: valid,
      });
      evidence.push(detail);
      log(detail);
    } finally {
      bot._client.write = write;
      bot.off("itemDrop", onDrop);
    }
  }
  return { status: passed ? "succeeded" : "failed", detail: evidence.join("\n") };
};
