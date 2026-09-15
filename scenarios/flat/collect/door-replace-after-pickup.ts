import {
  ActionRunner,
  createCollectBlockAction,
  createPlaceBlockAction,
  createNavigateAction,
} from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { cellIntersectsPlayerBody } from "../../../src/utils/index.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await bot.waitForTicks(5);
  const runner = new ActionRunner();
  const target = new Vec3(2, -59, 0);
  const collected = await runner.run(
    createCollectBlockAction(bot, context.navigation),
    { block_name: "birch_door", count: 1, scaffold: false, x: target.x, y: target.y, z: target.z },
    context.signal,
  );
  context.log(`collected=${JSON.stringify(collected)}; feet=${bot.entity.position}`);
  if (collected.result.status !== "succeeded") {
    return { status: "failed", detail: "Fixture door collection failed." };
  }
  // Pickup can settle just outside the doorway. Recreate the live failure's
  // occupied cell through normal movement, independently of where the item lands.
  if (!cellIntersectsPlayerBody(target, bot.entity.position)) {
    const positioned = await runner.run(
      createNavigateAction(bot, context.navigation),
      { x: target.x, y: target.y, z: target.z, range: 0, dig: false, scaffold: false },
      context.signal,
    );
    context.log(`positioned=${JSON.stringify(positioned)}; feet=${bot.entity.position}`);
  }
  if (!cellIntersectsPlayerBody(target, bot.entity.position)) {
    return { status: "failed", detail: "Fixture bot must occupy the doorway before replacement." };
  }
  const placed = await runner.run(
    createPlaceBlockAction(bot, context.navigation),
    { block_name: "birch_door", x: target.x, y: target.y, z: target.z },
    context.signal,
  );
  return { status: placed.result.status === "succeeded" ? "succeeded" : "failed", detail: JSON.stringify(placed) };
};
