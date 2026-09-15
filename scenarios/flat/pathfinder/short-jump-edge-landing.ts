import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { Vec3 } from "vec3";
import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  await standStill(context);
  const contacts: { position: Vec3; forward: boolean; sneak: boolean }[] = [];
  let deaths = 0;
  let minimumHealth = bot.health;
  const died = () => {
    deaths++;
  };
  const observe = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    if (bot.entity.onGround && bot.entity.position.x >= 2)
      contacts.push({
        position: bot.entity.position.clone(),
        forward: bot.getControlState("forward"),
        sneak: bot.getControlState("sneak"),
      });
  };
  bot.on("physicsTick", observe);
  bot.on("death", died);
  try {
    const result = await navigation.navigate({
      movements: createMovements(bot, { scaffolding: false }),
      goal: exactBlockGoal(new Vec3(2, -40, 0)),
      signal: context.signal,
    });
    // Retain two seconds of native physics: merely touching the pad before
    // coasting into the lava below is the recorded failure, not an arrival.
    await bot.waitForTicks(40);
    const retainedLanding = bot.entity.position.distanceTo(new Vec3(2.5, -40, 0.5)) <= 0.3;
    return {
      status:
        result.status === "completed" && retainedLanding && minimumHealth === 20 && deaths === 0
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        result,
        retainedLanding,
        minimumHealth,
        deaths,
        position: bot.entity.position,
        contactsCount: contacts.length,
        evidenceFile: await writeScenarioEvidence(context, "short-jump-edge-landing.json", { contacts }),
      }),
    };
  } finally {
    bot.off("physicsTick", observe);
    bot.off("death", died);
  }
};
