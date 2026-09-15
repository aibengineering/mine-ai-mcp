import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { fortressParamsSchema, observeFortress, prepareFortress, releaseThreats } from "./fortress-common.ts";

/** Acquire a rod and leave alive. The runtime owns combat and continuation. */
export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  const params = fortressParamsSchema.parse(context.scenario.params);
  await prepareFortress(context);
  const evidence = observeFortress(context);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const ownDeath = () => died.abort("bot died");
  const runtime = await openRuntime(context, "fortress-rod-and-exit");
  bot.on("death", ownDeath);
  try {
    const release = releaseThreats(context);
    const pending = runtime.run(
      runtime.actions.find((action) => action.name === "collect_mob_drop")!,
      { mob_name: "blaze", drop_name: "blaze_rod", count: 1 },
      signal,
    );
    await release;
    const hunt = await pending;
    log(`FORTRESS HUNT ${JSON.stringify(hunt)}`);
    if (evidence.snapshot().rods < 1)
      return { status: "failed", detail: JSON.stringify({ hunt, final: evidence.snapshot() }) };
    const [x, y, z] = params.exit;
    const exit = await runtime.run(
      runtime.actions.find((action) => action.name === "navigate")!,
      { x: Math.floor(x), y, z: Math.floor(z), range: 1 },
      signal,
    );
    const final = evidence.snapshot();
    const remaining = bot.entity.position.distanceTo(new Vec3(x, y, z));
    return {
      status:
        final.deaths === 0 && final.health > 0 && final.rods >= 1 && final.dimension === "the_nether" && remaining <= 2
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ hunt, exit, remaining, final }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: JSON.stringify({ reason: "bot died", final: evidence.snapshot() }) };
  } finally {
    log(`FORTRESS FINAL ${JSON.stringify(evidence.snapshot())}`);
    bot.off("death", ownDeath);
    evidence.close();
    await runtime.close();
  }
};
