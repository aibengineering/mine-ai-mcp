import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  attachHighlighter,
  ActionRunner,
  createCollectBlockAction,
  createCraftItemAction,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  rounds: z.number().int().positive(),
  logs: z.number().int().positive(),
});

/** The packets that carry inventory state, kept as a short tail for the report. */
const WATCHED_PACKETS = new Set([
  "set_slot",
  "window_items",
  "open_window",
  "close_window",
  "craft_recipe_response",
  "window_click",
  "craft_recipe_request",
  "set_held_item",
  "held_item_slot",
]);
const TAIL_LENGTH = 400;

interface PacketClient {
  on(event: "packet", listener: (data: unknown, meta: { readonly name: string }) => void): void;
  write(name: string, params: unknown): void;
}

function describe(name: string, data: unknown): string {
  const record = (data ?? {}) as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ["windowId", "stateId", "slot", "mode", "mouseButton", "inventoryType", "changedSlots"]) {
    if (key in record) {
      const value = record[key];
      fields.push(`${key}=${Array.isArray(value) ? value.length : String(value)}`);
    }
  }
  if ("item" in record) {
    const item = record.item as { itemId?: number; itemCount?: number; present?: boolean } | null;
    fields.push(`item=${item?.present === false ? "empty" : `${item?.itemId}x${item?.itemCount}`}`);
  }
  if ("items" in record && Array.isArray(record.items)) {
    const filled = (record.items as { present?: boolean; itemCount?: number }[]).filter(
      (item) => item && item.present !== false && (item.itemCount ?? 0) > 0,
    ).length;
    fields.push(`items=${record.items.length}(filled ${filled})`);
  }
  return `${name} ${fields.join(" ")}`;
}

/** The batch the seventh playthrough asked for after each respawn. */
const TOOL_BATCH = [
  { item_name: "crafting_table", count: 1 },
  { item_name: "wooden_pickaxe", count: 1 },
  { item_name: "wooden_axe", count: 1 },
  { item_name: "wooden_sword", count: 1 },
];

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const collect = createCollectBlockAction(bot, context.navigation);
  const craft = createCraftItemAction(bot, context.navigation);
  const request = paramsSchema.parse(context.scenario.params);

  const tail: string[] = [];
  const note = (line: string) => {
    tail.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (tail.length > TAIL_LENGTH) tail.shift();
  };
  const client = (bot as unknown as { _client: PacketClient })._client;
  client.on("packet", (data, meta) => {
    if (WATCHED_PACKETS.has(meta.name)) note(`<- ${describe(meta.name, data)}`);
  });
  const write = client.write.bind(client);
  client.write = (name, params) => {
    if (WATCHED_PACKETS.has(name)) note(`-> ${describe(name, params)}`);
    write(name, params);
  };

  const stages: string[] = [];
  try {
    await bot.waitForChunksToLoad();
    for (let round = 1; round <= request.rounds; round += 1) {
      const collected = await runner.run(
        collect,
        { block_name: "logs", count: request.logs, scaffold: true },
        context.signal,
      );
      stages.push(`round ${round} collect ${collected.result.status} ${collected.durationMs} ms`);
      if (collected.result.status !== "succeeded") {
        throw new Error(`round ${round} collect ${collected.result.status}: ${collected.result.error ?? "no error"}`);
      }
      note(
        `-- round ${round} craft begins; grid ${JSON.stringify(bot.inventory.slots.slice(1, 5).map((s) => s?.name ?? null))}`,
      );
      const crafted = await runner.run(craft, { items: TOOL_BATCH }, context.signal);
      stages.push(`round ${round} craft ${crafted.result.status} ${crafted.durationMs} ms`);
      context.log(stages.at(-1) ?? "");
      if (crafted.result.status !== "succeeded") {
        const plan = (crafted.result as { craft?: { plan?: { steps?: { item: string; count: number }[] } } }).craft
          ?.plan?.steps;
        const order = plan ? plan.map((step) => `${step.item}x${step.count}`).join(", ") : "unknown";
        throw new Error(
          `round ${round} craft ${crafted.result.status}: ${crafted.result.error ?? "no error"}; plan order ${order}`,
        );
      }
    }
    return { status: "succeeded", detail: stages.join("; ") };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    const evidenceFile = await writeScenarioEvidence(context, "craft-after-collect.json", { packets: tail, stages });
    return {
      status: "failed",
      detail: `${complaint}; stages ${stages.join("; ") || "none"}; evidence: ${evidenceFile}`,
    };
  }
}
