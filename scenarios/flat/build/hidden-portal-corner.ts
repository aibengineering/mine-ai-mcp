import { Vec3 } from "vec3";
import { ActionRunner, createBuildStructureAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
  const result = await new ActionRunner().run(
    createBuildStructureAction(context.bot, context.navigation),
    { portal_frame: { x: 1, y: -59, z: 0, axis: "x", corner_block: "obsidian" }, remove_wrong_blocks: true },
    context.signal,
  );
  const corner = context.bot.blockAt(new Vec3(3, -56, 0))?.name;
  return {
    status: result.result.status === "succeeded" && corner === "obsidian" ? "succeeded" : "failed",
    detail: `${JSON.stringify(result)}; corner=${corner}; feet=${context.bot.entity.position}`,
  };
};
