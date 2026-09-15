import { USE_BUCKET } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  if (!(await standStill(context))) return { status: "failed", detail: "Bot did not settle in the entry chamber." };
  const runtime = await openRuntime(context, "bucket-sealed-pocket");
  let enteredWater = false;
  const dug: { x: number; y: number; z: number }[] = [];
  const observe = () => {
    enteredWater ||= Reflect.get(context.bot.entity, "isInWater") === true;
  };
  const onDig: Parameters<typeof context.bot.on<"diggingCompleted">>[1] = (block) => {
    dug.push({ x: block.position.x, y: block.position.y, z: block.position.z });
  };
  context.bot.on("physicsTick", observe);
  context.bot.on("diggingCompleted", onDig);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === USE_BUCKET);
    if (!action) throw new Error("Bucket action missing.");
    const output = await runtime.run(action, { action: "fill", liquid: "water", x: 6, y: -58, z: 0 }, context.signal);
    await context.bot.waitForTicks(20);
    observe();
    const filled = context.bot.inventory.items().some((item) => item.name === "water_bucket");
    const grounded = context.bot.entity.onGround;
    const detail = JSON.stringify({
      result: output.result,
      filled,
      enteredWater,
      grounded,
      dug,
      end: context.bot.entity.position,
    });
    context.log(detail);
    return {
      status: output.result.status === "succeeded" && filled && context.bot.health > 0 ? "succeeded" : "failed",
      detail,
    };
  } finally {
    context.bot.off("physicsTick", observe);
    context.bot.off("diggingCompleted", onDig);
    await runtime.close();
  }
}
