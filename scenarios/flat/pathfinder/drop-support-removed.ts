import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { Vec3 } from "vec3";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  await standStill(context);
  const observation = new AbortController();
  const signal = AbortSignal.any([context.signal, observation.signal]);
  let removed = false;
  let invalidated = false;
  let ticksAfterRemoval = 0;
  const release = navigation.onEvent((event) => {
    if (event.kind === "route_committed" && !removed) {
      removed = true;
      bot.chat("/setblock 1 -42 0 air");
    }
    if (event.kind === "world_change" && event.change.position.x === 1 && event.change.position.y === -42)
      invalidated ||= event.classification === "invalidating";
  });
  const tick = () => {
    // Two seconds covers the native fall to the ground below. End the fixture
    // instead of asking an unreachable-goal search to scan the entire world.
    if (removed && ++ticksAfterRemoval === 40) observation.abort(new Error("Landing removal observed"));
  };
  bot.on("physicsTick", tick);
  try {
    const outcome = await navigation.navigate({
      movements: createMovements(bot, { scaffolding: false, allowParkour: false }),
      goal: exactBlockGoal(new Vec3(1, -41, 0)),
      signal,
    }).catch((cause: unknown) => {
      if (!observation.signal.aborted) throw cause;
      return { observationComplete: true };
    });
    return {
      status: removed && invalidated && bot.health === 20 && bot.entity.position.y === -40 ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, removed, invalidated, health: bot.health, position: bot.entity.position }),
    };
  } finally {
    release();
    bot.off("physicsTick", tick);
  }
};
