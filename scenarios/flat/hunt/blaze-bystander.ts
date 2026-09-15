import type { BotEvents } from "mineflayer";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { run as hunt } from "../../src/hunter.ts";

export const run: MineAiScenario = async (context) => {
  let bystanderHits = 0;
  const onHurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.name === "zombified_piglin") bystanderHits += 1;
  };
  context.bot.on("entityHurt", onHurt);
  try {
    const result = await hunt(context);
    return {
      ...result,
      status: bystanderHits === 0 ? result.status : "failed",
      detail: `${bystanderHits} hits on the neutral bystander; ${result.detail}`,
    };
  } finally {
    context.bot.off("entityHurt", onHurt);
  }
};
