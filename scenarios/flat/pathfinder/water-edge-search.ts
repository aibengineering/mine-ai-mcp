import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { createMovements, nearGoal } from "../../../src/navigation/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Qualify the first physical step, not the distant surface journey. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const feet = bot.blockAt(new Vec3(0, -59, 0));
  const head = bot.blockAt(new Vec3(0, -58, 0));
  const edge = bot.blockAt(new Vec3(0, -59, 1));
  const level = Number(edge?.getProperties().level);
  const inWater = Reflect.get(bot.entity, "isInWater") === true;
  context.log(
    `Edge geometry: feet=${feet?.name}, head=${head?.name}, adjacent=${edge?.name}:${level}, isInWater=${inWater}.`,
  );
  if (feet?.name !== "air" || head?.name !== "air" || edge?.name !== "water" || level !== 7 || !inWater)
    return { status: "failed", detail: "The live air-cell/flowing-water body overlap was not arranged." };

  const start = bot.entity.position.clone();
  const firstStep = new AbortController();
  let completed = 0;
  let changedStarts = 0;
  const stopObserving = context.pathfinder.onEvent((event) => {
    if (event.kind === "search_started" && event.reason === "start_changed") changedStarts += 1;
    if (event.kind === "step_completed") {
      completed += 1;
      firstStep.abort("Observed the first physical step from the water edge.");
    }
  });
  try {
    const result = await context.navigation.navigate({
      movements: createMovements(bot),
      // The live request was -895,64,-601: a distant surface goal that needs
      // enough search for stationary water buoyancy to run between slices.
      goal: nearGoal({ x: 18, y: 59, z: 5 }, 1),
      signal: context.signal,
      stopSignal: firstStep.signal,
    });
    const moved = bot.entity.position.distanceTo(start);
    return {
      status: completed > 0 && moved > 0.5 ? "succeeded" : "failed",
      detail: `Completed steps=${completed}, displacement=${moved.toFixed(2)}, start_changed=${changedStarts}; route=${result.status}; ${context.pathfinder.summary()}`,
    };
  } finally {
    stopObserving();
  }
}
