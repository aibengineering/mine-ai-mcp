import { Vec3 } from "vec3";
import { ActionRunner, createBuildStructureAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
  // Preserve the live stack boundary: the old primitive failed immediately
  // after the 47-item stack emptied, despite 80 more blocks being carried.
  for (const [slot, count] of [
    [1, 47],
    [2, 63],
    [3, 17],
  ]) {
    context.bot.chat(`/item replace entity ${context.bot.username} hotbar.${slot} with cobblestone ${count}`);
  }
  while (context.bot.inventory.count(context.bot.registry.itemsByName.cobblestone!.id, null) !== 127) {
    context.signal.throwIfAborted();
    await context.bot.waitForTicks(1);
  }
  const blocks: { x: number; y: number; z: number; block_name: string }[] = [];
  for (let x = 0; x <= 4; x++) blocks.push({ x, y: -61, z: 4, block_name: "cobblestone" });
  for (let y = -60; y <= -59; y++) {
    for (let x = 0; x <= 4; x++) {
      for (let z = 0; z <= 4; z++) {
        if (x === 0 || x === 4 || z === 0 || z === 4) blocks.push({ x, y, z, block_name: "cobblestone" });
      }
    }
  }
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 4; z++) blocks.push({ x, y: -58, z, block_name: "cobblestone" });
  }
  const result = await new ActionRunner().run(
    createBuildStructureAction(context.bot, context.navigation),
    { blocks, remove_wrong_blocks: true },
    context.signal,
  );
  const observed = context.bot.blockAt(new Vec3(1, -58, 2))?.name;
  return {
    status: result.result.status === "succeeded" && observed === "cobblestone" ? "succeeded" : "failed",
    detail: `${JSON.stringify(result)}; observed=${observed}; feet=${context.bot.entity.position}`,
  };
};
