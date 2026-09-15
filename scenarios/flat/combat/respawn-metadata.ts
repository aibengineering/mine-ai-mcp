import type { BotEvents } from "mineflayer";
import { createViewStatusAction, SqlBotData } from "@aibengineering/mine-ai-mcp";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  await standStill(context);
  let died = false;
  let respawned = false;
  let sawBurning = false;
  const packets: unknown[] = [];
  const metadata: BotEvents["entityUpdate"] = (entity) => {
    if (entity === bot.entity && typeof entity.metadata[0] === "number" && (entity.metadata[0] & 1) !== 0)
      sawBurning = true;
  };
  const death = () => {
    died = true;
  };
  const respawn = (packet: unknown) => {
    respawned = true;
    packets.push(packet);
    log(`respawn packet ${JSON.stringify(packet)}`);
  };
  bot.on("entityUpdate", metadata);
  bot.on("death", death);
  bot._client.on("respawn", respawn);
  const initialId = bot.entity.id;
  try {
    bot.chat("/spawnpoint @s 0 -60 0");
    bot.chat("/tp @s 5.5 -60 0.5");
    for (let ticks = 0; ticks < 400 && !(died && respawned && bot.health > 0); ticks++) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await bot.waitForTicks(40);
    const data = SqlBotData.create({
      storage: { kind: "temporary" },
      identity: { worldId: "respawn-metadata", scope: { kind: "bot", botId: bot.username } },
    });
    try {
      const action = createViewStatusAction(bot, data, () => ({ owner: "idle", activeAction: null }));
      const result = await action.execute({}, {});
      const evidence = {
        sawBurning,
        died,
        respawned,
        initialId,
        currentId: bot.entity.id,
        metadata: bot.entity.metadata,
        vitals: result.situation.vitals,
        packets,
      };
      return {
        status:
          sawBurning && died && respawned && result.situation.vitals.burning !== true && bot.health === 20
            ? "succeeded"
            : "failed",
        detail: JSON.stringify(evidence),
      };
    } finally {
      data.close();
    }
  } finally {
    bot.off("entityUpdate", metadata);
    bot.off("death", death);
    bot._client.off("respawn", respawn);
  }
};
