import { attachEndermanGazeControl } from "../../src/survival/guards/enderman-gaze.ts";
import { declaredEntitiesArranged } from "./runtime.ts";
import type { MineAiScenario } from "./scenario-client.ts";

/** The End platform, the probe Enderman and the dragon's absence are all the scenario file's. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await declaredEntitiesArranged(context);
  const target = Object.values(bot.entities).find((e) => e.name === "enderman" && e.isValid);
  if (!target) throw new Error("Native gaze probe Enderman was not loaded");
  const creepy = bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy");
  const angry = () => {
    const flag: unknown = target.metadata[creepy];
    return flag === true;
  };
  const guard = attachEndermanGazeControl(bot, () => null);
  const healthBefore = bot.health;
  let prevented = 0;
  try {
    for (let tick = 0; tick < 40; tick++) {
      signal.throwIfAborted();
      await bot.lookAt(target.position.offset(0, 2.55, 0), true);
      await bot.waitForTicks(1);
      if (angry() || bot.health < healthBefore) throw new Error("Guarded gaze provoked native Enderman aggression");
      if (bot.entity.pitch < -1) prevented++;
    }
  } finally {
    guard[Symbol.dispose]();
  }
  // Positive control: the same real mob must respond to unguarded eye contact.
  for (let tick = 0; tick < 40 && !angry(); tick++) {
    signal.throwIfAborted();
    await bot.lookAt(target.position.offset(0, 2.55, 0), true);
    await bot.waitForTicks(1);
  }
  return {
    status: prevented === 40 && angry() ? "succeeded" : "failed",
    detail: JSON.stringify({ prevented, guardedHealth: healthBefore, unguardedAggressionObserved: angry() }),
  };
};
