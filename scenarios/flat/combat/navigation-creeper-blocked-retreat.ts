import { declaredEntitiesArranged, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";
import { run as navigateThroughCombat } from "./combat-handoff.ts";

/** Equip before Mine Labs releases the native mobs; do not spend the fuse dressing. */
export const prepare: MineAiScenarioPreparation = async (context) => {
  if (!(await standStill(context))) throw new Error("The passage start did not settle.");
  await wearArmor(context);
  const shield = context.bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) throw new Error("The arranged shield was not supplied.");
  await context.bot.equip(shield, "off-hand");
};

/** Ordinary navigation and the production reflex driver own all response choices. */
export const run: MineAiScenario = async (context) => {
  await declaredEntitiesArranged(context);
  return navigateThroughCombat(context);
};
