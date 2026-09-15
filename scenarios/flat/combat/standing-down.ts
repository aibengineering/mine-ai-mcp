import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { hurt } from "./reflex.ts";

const paramsSchema = z.strictObject({
  hurtTo: z.number().int().positive(),
  waitTicks: z.number().int().positive(),
  navigateTo: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
});

/** Missing construction supplies must not prevent an otherwise achievable journey. */
export const run: MineAiScenario = async (context) => {
  const params = paramsSchema.parse(context.scenario.params);
  const runtime = await openRuntime(context, "wounded-navigation-without-blocks");
  let died = false;
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    if (!(await hurt(context, params.hurtTo)))
      return { status: "failed", detail: "Arrangement did not establish wounded health." };
    for (let tick = 0; tick < params.waitTicks && !died; tick++) {
      context.signal.throwIfAborted();
      await context.bot.waitForTicks(1);
    }
    const [x, y, z] = params.navigateTo;
    const output = await runtime.run(
      runtime.actions.find((action) => action.name === NAVIGATE)!,
      { x, y, z, range: 1 },
      context.signal,
    );
    const remaining = context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5));
    return {
      status: !died && context.bot.health > 0 && remaining <= 2 ? "succeeded" : "failed",
      detail: JSON.stringify({ output, died, health: context.bot.health, remaining }),
    };
  } finally {
    context.bot.off("death", death);
    await runtime.close();
  }
};
