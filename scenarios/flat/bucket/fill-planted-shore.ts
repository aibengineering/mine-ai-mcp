import { USE_BUCKET } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Run 17 selected underwater plants as dry stands and left the shore without filling. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  if (!(await standStill(context))) return { status: "failed", detail: "Bot did not settle on the bank." };
  const runtime = await openRuntime(context, "bucket-planted-shore");
  const start = context.bot.entity.position.clone();
  let enteredWater = false;
  const observe = () => {
    enteredWater ||= Reflect.get(context.bot.entity, "isInWater") === true;
  };
  context.bot.on("physicsTick", observe);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === USE_BUCKET);
    if (!action) throw new Error("Bucket action missing.");
    const results: Awaited<ReturnType<typeof runtime.run>>["result"][] = [];
    for (let bucket = 0; bucket < 2; bucket += 1) {
      const output = await runtime.run(action, { action: "fill", liquid: "water" }, context.signal);
      results.push(output.result);
      // One second includes the landing after a route returns partway into a drop.
      await context.bot.waitForTicks(20);
    }
    observe();
    const filled = context.bot.inventory
      .items()
      .filter((item) => item.name === "water_bucket")
      .reduce((count, item) => count + item.count, 0);
    const detail = JSON.stringify({ start, end: context.bot.entity.position, enteredWater, filled, results });
    context.log(detail);
    const succeeded = results.every((result) => result.status === "succeeded") && filled === 2;
    return { status: succeeded ? "succeeded" : "failed", detail };
  } finally {
    context.bot.off("physicsTick", observe);
    await runtime.close();
  }
}
