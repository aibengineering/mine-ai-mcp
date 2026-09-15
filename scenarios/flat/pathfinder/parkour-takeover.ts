import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal, log }) => {
  await bot.waitForChunksToLoad();
  const runner = new ActionRunner();
  let claim: Promise<boolean> | null = null;
  const tick = () => {
    if (claim || bot.entity.onGround || bot.entity.position.x < 1.5) return;
    log(`Claim requested mid-flight at ${bot.entity.position}`);
    const admission = runner.claim("fixture_reflex", "Observed mid-flight takeover regression", async () => {
      const settled = bot.entity.onGround && bot.entity.position.y >= -58.1 && bot.entity.position.x >= 4;
      log(`Claim received body at ${bot.entity.position}, onGround=${bot.entity.onGround}`);
      bot.clearControlStates();
      await bot.waitForTicks(20);
      return { value: settled && bot.entity.onGround && bot.entity.position.y >= -58.1, continuation: { kind: "return" as const, reason: null } };
    });
    if (admission.kind !== "claimed") throw new Error("The fixture body claim was not admitted.");
    claim = admission.outcome;
  };
  bot.on("physicsTick", tick);
  try {
    const output = await runner.run(
      createNavigateAction(bot, navigation),
      {
        x: 4,
        y: -58,
        z: 0,
        range: 0,
        dig: false,
        scaffold: false,
      },
      signal,
    );
    const settled = claim !== null && (await claim);
    return { status: settled ? "succeeded" : "failed", detail: JSON.stringify({ settled, output }) };
  } finally {
    bot.removeListener("physicsTick", tick);
  }
};
