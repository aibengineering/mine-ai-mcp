import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { Vec3 } from "vec3";
import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  await standStill(context);
  let jumped = false;
  let minimumHealth = bot.health;
  let magmaContact = false;
  const frames: unknown[] = [];
  const stopObserving = navigation.onEvent((event) => {
    if (event.kind === "step_started" && event.movement === "parkour") jumped = true;
  });
  const observe = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    const support = bot.blockAt(bot.entity.position.offset(0, -0.1, 0))?.name;
    magmaContact ||= bot.entity.onGround && support === "magma_block";
    frames.push({
      position: bot.entity.position.clone(),
      velocity: bot.entity.velocity.clone(),
      onGround: bot.entity.onGround,
      support,
      forward: bot.getControlState("forward"),
      back: bot.getControlState("back"),
    });
  };
  bot.on("physicsTick", observe);
  try {
    const result = await navigation.navigate({
      movements: createMovements(bot, { scaffolding: false }),
      goal: exactBlockGoal(new Vec3(2, -39, 0)),
      signal: context.signal,
    });
    // Observe the landing after route completion as well as first contact.
    await bot.waitForTicks(40);
    const retainedLanding = bot.entity.position.distanceTo(new Vec3(2.5, -39, 0.5)) <= 0.3;
    return {
      status:
        result.status === "completed" && jumped && retainedLanding && minimumHealth === 20 && !magmaContact
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        result,
        jumped,
        retainedLanding,
        minimumHealth,
        magmaContact,
        framesCount: frames.length,
        evidenceFile: await writeScenarioEvidence(context, "ascending-jump-magma-landing.json", { frames }),
      }),
    };
  } finally {
    stopObserving();
    bot.off("physicsTick", observe);
  }
};
