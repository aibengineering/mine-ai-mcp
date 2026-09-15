import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await wearArmor(context);
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  await bot.equip(shield, "off-hand");
  let controller!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "incoming-fireball-during-fight", {
    createCombatController: (...dependencies) => (controller = createCombatController(...dependencies)),
  });
  const origin = bot.entity.position.clone();
  let fired = false,
    reflected = false,
    approaching = false,
    gone = false;
  let activeAtShot: unknown = null;
  let minimumY = origin.y;
  const observe = () => {
    minimumY = Math.min(minimumY, bot.entity.position.y);
    if (!fired && controller.execution()?.phase === "guard") {
      fired = true;
      activeAtShot = { owner: runtime.status(), execution: controller.execution() };
      bot.chat("/summon minecraft:fireball 12.5 -53 0.5 {Motion:[-0.5d,0.0d,0.0d],ExplosionPower:1b}");
    }
    const ball = Object.values(bot.entities).find((entity) => entity.name === "fireball" && entity.isValid);
    if (approaching && !ball) gone = true;
    if (ball) {
      approaching ||= ball.velocity.x < -0.05;
      reflected ||= approaching && ball.velocity.x > 0.05;
    }
  };
  bot.on("physicsTick", observe);
  try {
    bot.chat(
      '/summon blaze 0.5 -54 12.5 {PersistenceRequired:1b,Health:80f,attributes:[{id:"minecraft:max_health",base:80.0}]}',
    );
    // Production reflex owns the blaze fight and must also answer the new shot.
    while (!reflected && !gone && bot.health > 0 && minimumY >= origin.y - 0.5) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    return {
      status: fired && reflected && minimumY >= origin.y - 0.5 ? "succeeded" : "failed",
      detail: JSON.stringify({
        fired,
        reflected,
        gone,
        activeAtShot,
        minimumY,
        health: bot.health,
        support: bot.blockAt(origin.offset(0, -1, 0))?.name,
      }),
    };
  } finally {
    bot.off("physicsTick", observe);
    await runtime.close();
  }
};
