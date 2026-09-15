import assert from "node:assert/strict";
import { smeltItemResultSchema } from "@aibengineering/mine-ai-mcp";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

type FurnacePropertyPacket = { windowId: number; property: number; value: number };

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "smelt-batch");
  const count = Number(context.scenario.params.count ?? 8);
  const temporary = context.scenario.params.temporary === true;
  const packetStart = performance.now();
  const packetProgress: Array<{ elapsedMs: number; windowId: number; property: number; value: number }> = [];
  const packetCounts = { fuel: 0, totalFuel: 0, progress: 0, totalProgress: 0 };
  const onProperty = (packet: FurnacePropertyPacket) => {
    if (packet.property > 3) return;
    const key = (["fuel", "totalFuel", "progress", "totalProgress"] as const)[packet.property]!;
    packetCounts[key] += 1;
    // Keep native boundaries and twentieth-tick samples. The complete packet
    // stream is too large to duplicate in a one-line scenario result.
    if (packet.property >= 2 && (packet.value === 0 || packet.value % 20 === 0))
      packetProgress.push({ elapsedMs: Math.round(performance.now() - packetStart), ...packet });
  };
  bot._client.on("craft_progress_bar", onProperty);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === "smelt_item")!;
    const started = performance.now();
    const output = await runtime.run(
      action,
      temporary
        ? { temporary_workstation: true, item_name: "raw_iron", count, fuel_item_name: "coal" }
        : { x: 2, y: -59, z: 0, item_name: "raw_iron", count, fuel_item_name: "coal" },
      signal,
    );
    const result = smeltItemResultSchema.parse(output.result);
    const cooked = bot.inventory.items().filter((item) => item.name === "iron_ingot").reduce((n, item) => n + item.count, 0);
    const raw = bot.inventory.items().filter((item) => item.name === "raw_iron").reduce((n, item) => n + item.count, 0);
    context.log(JSON.stringify({ result, actionDurationMs: output.durationMs, monotonicDurationMs: Math.round(performance.now() - started), cooked, raw, packetCounts, packetProgress }));
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(cooked, count);
    assert.equal(raw, 0);
    assert.equal(cooked, result.smelt.produced);
    assert.equal(raw, count - cooked);
    if (temporary) assert.equal(result.workstation?.recovered, true);
    return { status: "succeeded", detail: `Observed ${cooked}/${count} cooked and ${raw} raw in ${output.durationMs} ms.` };
  } finally {
    bot._client.off("craft_progress_bar", onProperty);
    await runtime.close();
  }
};
