import type { Bot } from "mineflayer";
import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { declaredEntitiesArranged, declaredStart, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  const start = declaredStart(context);
  await bot.waitForChunksToLoad();
  log(
    `SITE ${JSON.stringify(
      [-1, 0, 1, 2].map((dy) => {
        const block = bot.blockAt(start.offset(0, dy, 0));
        return { position: block?.position, name: block?.name, stateId: block?.stateId };
      }),
    )}`,
  );
  await declaredEntitiesArranged(context);
  if (!(await standStill(context))) throw new Error("The recorded standing cell did not settle.");
  await wearArmor(context);
  // Start with known neutral mobs: a random spawn yaw must not provoke one
  // before the first engagement's protection decision is measured.
  await bot.lookAt(start.offset(0, -1, 0), true);
  const fixtureEndermanIds = new Set(
    Object.values(bot.entities)
      .filter((entity) => entity.name === "enderman")
      .map((entity) => entity.id),
  );
  let combat!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "enderman-expedition-site", {
    createCombatController: (...dependencies) => (combat = createCombatController(...dependencies)),
  });
  let refused = false;
  const remove = combat.onDecision((event) => {
    refused ||= event.kind === "roof_prepared" && event.stopped !== null;
  });
  let minimumHealth = bot.health;
  let fixtureEndermanDied = false;
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const dead = (entity: Bot["entity"]) => {
    if (fixtureEndermanIds.has(entity.id)) fixtureEndermanDied = true;
  };
  bot.on("physicsTick", tick);
  bot.on("entityDead", dead);
  try {
    bot.chat("/execute as @e[tag=pair] run data merge entity @s {NoAI:0b}");
    const hunt = runtime.actions.find((action) => action.name === "collect_mob_drop");
    if (!hunt) throw new Error("The expedition site requires the normal mob-drop collection action.");
    const result = await runtime.run(
      hunt,
      { mob_name: "enderman", drop_name: "ender_pearl", count: 1 },
      context.signal,
    );
    await bot.waitForTicks(100);
    return {
      status: fixtureEndermanDied && minimumHealth > 0 && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        fixtureEndermanIds: [...fixtureEndermanIds],
        fixtureEndermanDied,
        result,
        refused,
        minimumHealth,
        health: bot.health,
      }),
    };
  } finally {
    bot.off("physicsTick", tick);
    bot.off("entityDead", dead);
    remove();
    await runtime.close();
  }
};
