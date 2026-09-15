import { ActionRunner, createCollectBlockAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  let damageCount = 0;
  const onDamage = (packet: { entityId: number }) => {
    if (packet.entityId === bot.entity.id) {
      const observed = {
        packet,
        position: { ...bot.entity.position },
        velocity: { ...bot.entity.velocity },
        health: bot.health,
      };
      damageCount++;
      context.log(`Damage: ${JSON.stringify(observed)}`);
    }
  };
  bot._client.on("damage_event", onDamage);
  try {
    const result = await new ActionRunner().run(
      createCollectBlockAction(bot, context.navigation),
      {
        block_name: "diamond_ore",
        count: 3,
      },
      context.signal,
    );
    return {
      status: result.result.status === "succeeded" && damageCount === 0 && bot.health === 20 ? "succeeded" : "failed",
      detail: `${JSON.stringify(result)}; damage events=${damageCount}; ${context.pathfinder.summary()}`,
    };
  } finally {
    bot._client.off("damage_event", onDamage);
  }
};
