import { z } from "zod";
import { entityHealth } from "../../src/world/end-fight.ts";
import { prepare as prepareEnd } from "./ender-dragon.ts";
import { recordedLoadoutSchema, restoreRecordedLoadout } from "./recorded-loadout.ts";
import type { MineAiScenarioPreparation } from "./scenario-client.ts";
export { run } from "./ender-dragon.ts";

export const prepare: MineAiScenarioPreparation = async context => {
  await prepareEnd(context);
  const { bot, signal } = context;
  const params = z.object({ dragon_health: z.number().int().positive(), loadout: recordedLoadoutSchema }).parse(context.scenario.params);
  const dragon = Object.values(bot.entities).find(e => e.isValid && e.name === "ender_dragon");
  if (!dragon) throw new Error("Replay dragon was not observed");
  bot.chat(`/execute in minecraft:the_end run data merge entity @e[type=ender_dragon,limit=1] {Health:${params.dragon_health}.0f}`);
  await restoreRecordedLoadout(bot, params.loadout, signal);
  if (entityHealth(bot, dragon) !== params.dragon_health) throw new Error("Replay dragon health was not acknowledged");
};
