import { Vec3 } from "vec3";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Knockback at the first swing tests the stance chosen before contact. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Initial ledge did not settle");
  const target = Object.values(bot.entities).find((e) => e.name === "magma_cube");
  if (!target) throw new Error("The arranged cube was not observed");
  const attack = bot.attack.bind(bot);
  let firstSwing: Vec3 | null = null;
  let afterSwing = 0;
  let minimumHealth = bot.health;
  let touchedLava = false;
  bot.attack = (...args) => {
    attack(...args);
    if (firstSwing) return;
    firstSwing = bot.entity.position.clone();
    const away = firstSwing.minus(target.position);
    away.y = 0;
    away.normalize().scale(0.4);
    bot.entity.velocity.set(away.x, 0.36075, away.z);
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    touchedLava ||= Reflect.get(bot.entity, "isInLava") === true;
    if (firstSwing && ++afterSwing === 2) bot.chat("/kill @e[type=magma_cube]");
  };
  bot.on("physicsTick", tick);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
const outcome = await scenarioCombat1.controller.engage(target.id, signal, "pursue");
    await bot.waitForTicks(20);
    return {
      status:
        outcome.kind === "died" && firstSwing !== null && minimumHealth === 20 && !touchedLava && bot.entity.onGround
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        outcome,
        firstSwing,
        minimumHealth,
        touchedLava,
        final: bot.entity.position,
        grounded: bot.entity.onGround,
      }),
    };
  } finally {
    bot.attack = attack;
    bot.off("physicsTick", tick);
  }
};
