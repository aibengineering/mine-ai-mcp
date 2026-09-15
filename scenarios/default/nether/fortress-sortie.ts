/** One native blaze hunt and one return to a surveyed fortress exit. */
import { COLLECT_MOB_DROP, NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { fortressParamsSchema, observeFortress, prepareFortress, releaseThreats } from "./fortress-common.ts";

export const run: MineAiScenario = async (context) => {
  const params = fortressParamsSchema.parse(context.scenario.params);
  await prepareFortress(context);
  const evidence = observeFortress(context);
  try {
    await releaseThreats(context);
    const runtime = await openRuntime(context, "fortress-sortie-20260906");
    try {
      const hunt = runtime.actions.find((action) => action.name === COLLECT_MOB_DROP);
      const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
      if (!hunt || !navigate) throw new Error("Fortress trial requires the normal hunt and navigate actions.");
      const hunted = await runtime.run(hunt, { mob_name: "blaze", drop_name: "blaze_rod", count: 1 }, context.signal);
      context.log(`HUNT ${JSON.stringify(hunted.result)}`);
      if (evidence.snapshot().deaths > 0) return { status: "failed", detail: JSON.stringify(evidence.snapshot()) };
      const [x, y, z] = params.exit;
      const returned = await runtime.run(navigate, { x, y, z, range: 1 }, context.signal);
      context.log(`RETURN ${JSON.stringify(returned.result)}`);
      // Five seconds keeps the runtime active for delayed fireballs/contact.
      for (let tick = 0; tick < 100 && evidence.snapshot().deaths === 0; tick++) {
        context.signal.throwIfAborted();
        await context.bot.waitForTicks(1);
      }
      const final = evidence.snapshot();
      const atExit = context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) <= 2;
      return {
        status:
          final.deaths === 0 && final.health > 0 && final.dimension === "the_nether" && final.rods >= 1 && atExit
            ? "succeeded"
            : "failed",
        detail: JSON.stringify({
          ...final,
          atExit,
          huntStatus: hunted.result.status,
          returnStatus: returned.result.status,
          interruptions: [...(hunted.interruptions ?? []), ...(returned.interruptions ?? [])],
        }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    context.log(`FINAL ${JSON.stringify(evidence.snapshot())}`);
    evidence.close();
  }
};
