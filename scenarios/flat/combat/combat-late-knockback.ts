import { SupportedPositionHold } from "../../../src/navigation/steering/supported-position.ts";
import { CombatItemUse } from "../../../src/survival/weapons/item-use.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Replay the pending velocity seen when the pack's health update cancelled combat. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  if (!(await standStill(context))) throw new Error("The release ledge did not settle");
  const hold = new SupportedPositionHold(bot, navigation.world);
  let minimumHealth = bot.health;
  let lava = false;
  const tick = () => {
    hold.tick();
    minimumHealth = Math.min(minimumHealth, bot.health);
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
  };
  bot.on("physicsTick", tick);
  try {
    const shield = bot.inventory.items().find((item) => item.name === "shield")!;
    await bot.equip(shield, "off-hand");
    const use = new CombatItemUse(bot, (ticks) => bot.waitForTicks(ticks));
    await use.raiseShield();
    // onGround still describes the last physics step; velocity describes the
    // next one. Cleanup used to release now, then receive the hop in its wait.
    const groundedBefore = bot.entity.onGround;
    bot.entity.velocity.set(-0.4275, 0.36075, 0.017125);
    await use.neutralise(() => hold.stop(context.signal), context.signal);
    const groundedAtReturn = bot.entity.onGround;
    await bot.waitForTicks(20);
    return {
      status:
        groundedBefore && groundedAtReturn && bot.entity.onGround && !lava && minimumHealth === 20
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ groundedBefore, groundedAtReturn, lava, minimumHealth, final: bot.entity.position }),
    };
  } finally {
    hold.release();
    bot.off("physicsTick", tick);
  }
};
