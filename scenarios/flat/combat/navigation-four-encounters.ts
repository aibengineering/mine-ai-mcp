import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Four server entities exercise real combat claims, without teaching production code fixture identities. */
export const run: MineAiScenario = async ({ bot, signal }) => {
  const runtime = await createMinecraftRuntime(bot, {
    // Prove four actual handoffs; avoidance is covered by the field scenarios.
    stepFieldProvider: () => null,
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: "four-encounters", scope: { kind: "bot", botId: bot.username } },
    },
  });
  let deaths = 0;
  const onDead = (entity: { name?: string }) => {
    if (entity.name === "zombie") deaths++;
  };
  bot.on("entityDead", onDead);
  try {
    const action = runtime.actions.find((action) => action.name === "navigate");
    if (!action) throw new Error("Navigation action missing");
    const pending = runtime.run(action, { x: 45, y: -60, z: 0, range: 0, dig: false, scaffold: false }, signal);
    for (const x of [3, 4, 5, 6])
      bot.chat(`/summon minecraft:zombie ${x}.5 -60 1.5 {NoAI:1b,Health:1.0f,PersistenceRequired:1b}`);
    const output = await pending;
    const arrived = Math.floor(bot.entity.position.x) === 45 && Math.floor(bot.entity.position.z) === 0;
    return {
      status: output.result.status === "succeeded" && arrived ? "succeeded" : "failed",
      detail: JSON.stringify({ output, deaths, arrived, health: bot.health }),
    };
  } finally {
    bot.off("entityDead", onDead);
    await runtime.close();
  }
};
