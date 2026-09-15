import { canReleaseOnObservedGround } from "../../../../src/navigation/world/block-geometry.ts";
import { ScenarioCombat } from "../../../src/combat.ts";
import { declaredEntitiesArranged, declaredStart, standStill } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../../src/scenario-evidence.ts";

/** The recorded pack impulse, with a native target death during the hop. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  const start = declaredStart(context);
  await bot.waitForChunksToLoad();
  if (bot.blockAt(start.offset(0, -0.01, 0))?.name !== "basalt") throw new Error("Recorded support changed");
  await declaredEntitiesArranged(context);
  const targets = Object.values(bot.entities)
    .filter((e) => e.name === "magma_cube")
    .sort((a, b) => b.position.z - a.position.z);
  if (!(await standStill(context))) throw new Error("Cannot settle on recorded ledge");
  const finish = new AbortController();
  let ticks = 0;
  let airborneAtDeath = false;
  let minimumY = bot.entity.position.y;
  let minimumHealth = bot.health;
  const samples: unknown[] = [];
  const death = (entity: { id: number }) => {
    if (entity.id === targets[0]!.id) airborneAtDeath = !bot.entity.onGround;
  };
  const tick = () => {
    ticks++;
    if (ticks === 8) bot.entity.velocity.set(-0.351625, 0.36075, -0.190625);
    if (ticks === 9) bot.chat("/kill @e[tag=first]");
    minimumY = Math.min(minimumY, bot.entity.position.y);
    minimumHealth = Math.min(minimumHealth, bot.health);
    samples.push({
      ticks,
      position: bot.entity.position.clone(),
      onGround: bot.entity.onGround,
      controls: Object.fromEntries(
        (["forward", "back", "left", "right", "sneak"] as const).map((key) => [key, bot.getControlState(key)]),
      ),
    });
    // Three seconds covers the recorded 1.3-second fall and the next engagement.
    if (ticks === 60) finish.abort("handoff observation complete");
  };
  bot.on("physicsTick", tick);
  bot.on("entityDead", death);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const controller = scenarioCombat1.controller;
    const first = await controller.engage(targets[0]!.id, signal, "hold");
    const firstReturnedOnGround = bot.entity.onGround;
    const firstReturnedSafely = canReleaseOnObservedGround(navigation.world, bot.entity);
    const second = await controller.engage(targets[1]!.id, AbortSignal.any([signal, finish.signal]), "hold");
    await bot.waitForTicks(10);
    return {
      status:
        first.kind === "died" &&
        airborneAtDeath &&
        firstReturnedOnGround &&
        firstReturnedSafely &&
        // The impulse can miss the original ledge. A lower landing is valid
        // only within the ordinary damage-free drop, with observed full health.
        minimumY >= start.y - 3 &&
        minimumHealth === 20 &&
        bot.entity.onGround
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        first,
        second,
        airborneAtDeath,
        firstReturnedOnGround,
        firstReturnedSafely,
        minimumY,
        minimumHealth,
        ticks,
        evidenceFile: await writeScenarioEvidence(context, "generated-basalt-combat-handoff.json", { samples }),
      }),
    };
  } finally {
    bot.off("physicsTick", tick);
    bot.off("entityDead", death);
  }
};
