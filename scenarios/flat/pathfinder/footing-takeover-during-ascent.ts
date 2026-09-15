import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Replay a native impulse during navigation; recovery choice remains runtime policy. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  await using runtime = await openRuntime(context, "footing-takeover-during-ascent");
  const navigate = runtime.actions.find((action) => action.name === "navigate");
  if (!navigate) throw new Error("The navigate action is required.");
  let injected = false;
  let airborneTakeover = false;
  let deaths = 0;
  let minimumHealth = bot.health;
  let minimumY = bot.entity.position.y;

  const died = () => {
    deaths++;
  };
  const tick = () => {
    const status = runtime.status();
    if (
      !injected &&
      status.activeAction?.action === "navigate" &&
      !bot.entity.onGround &&
      bot.entity.position.y > -39.9
    ) {
      injected = true;
      // Recorded native pack impulse, in protocol units (1/8000 block/tick).
      bot._client.emit("entity_velocity", { entityId: bot.entity.id, velocity: { x: -2689, y: 2886, z: 1667 } });
    }
    if (!injected) return;
    airborneTakeover ||=
      status.activeAction?.action === "recover_footing" && status.owner === "takeover" && !bot.entity.onGround;
    minimumHealth = Math.min(minimumHealth, bot.health);
    minimumY = Math.min(minimumY, bot.entity.position.y);
  };
  bot.on("physicsTick", tick);
  bot.on("death", died);
  try {
    const result = await runtime.run(navigate, { x: 2, y: -39, z: 0, range: 0, scaffold: false }, context.signal);
    await bot.waitForTicks(20);
    return {
      status:
        result.result.status === "succeeded" &&
        injected &&
        Math.floor(bot.entity.position.x) === 2 &&
        Math.floor(bot.entity.position.y) === -39 &&
        Math.floor(bot.entity.position.z) === 0 &&
        minimumHealth === 20 &&
        deaths === 0 &&
        minimumY >= -40 &&
        bot.entity.onGround
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        result: result.result,
        injected,
        airborneTakeover,
        minimumHealth,
        minimumY,
        deaths,
      }),
    };
  } finally {
    bot.off("physicsTick", tick);
    bot.off("death", died);
  }
};
