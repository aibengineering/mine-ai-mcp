/** Reach the surveyed exit alive from a wounded start under native threat. */
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import { readEncounters, type Encounter } from "../../flat/combat/reflex.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { fortressParamsSchema, observeFortress, prepareFortress, releaseThreats } from "./fortress-common.ts";

export const run: MineAiScenario = async (context) => {
  const params = fortressParamsSchema.parse(context.scenario.params);
  await prepareFortress(context);
  const evidence = observeFortress(context);
  const encounters: Encounter[] = [];
  try {
    await releaseThreats(context);
    const runtime = await openRuntime(context, "fortress-withdrawal-20260906");
    try {
      const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
      if (!navigate) throw new Error("Fortress withdrawal requires the normal navigate action.");
      const [x, y, z] = params.exit;
      const returned = await runtime.run(navigate, { x, y, z, range: 1 }, context.signal);
      context.log(`RETURN ${JSON.stringify(returned.result)}`);
      // Keep the reflex and native mobs active for delayed contact after arrival.
      for (let tick = 0; tick < 100 && evidence.snapshot().deaths === 0; tick++) {
        context.signal.throwIfAborted();
        await context.bot.waitForTicks(1);
      }
      encounters.push(...(await readEncounters(context, runtime)));
      const final = evidence.snapshot();
      const atExit = context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) <= 2;
      return {
        status:
          final.deaths === 0 && final.health > 0 && final.dimension === "the_nether" && atExit ? "succeeded" : "failed",
        detail: JSON.stringify({ ...final, atExit, encounters, returnStatus: returned.result.status }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    context.log(`FINAL ${JSON.stringify(evidence.snapshot())}`);
    evidence.close();
  }
};
