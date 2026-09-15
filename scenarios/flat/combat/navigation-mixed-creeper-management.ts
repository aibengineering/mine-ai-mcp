import { declaredEntitiesArranged, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";
import { run as navigateThroughCombat } from "./combat-handoff.ts";

/** Equip before Mine Labs releases the distant group; preparation is not part of the crossing. */
export const prepare: MineAiScenarioPreparation = async (context) => {
  if (!(await standStill(context))) throw new Error("The arena start did not settle.");
  await wearArmor(context);
  const shield = context.bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) throw new Error("The arranged shield was not supplied.");
  await context.bot.equip(shield, "off-hand");
};

/** One ordinary crossing; production combat owns every fight and retreat decision. */
export const run: MineAiScenario = async (context) => {
  await declaredEntitiesArranged(context);
  return navigateThroughCombat(context);
};
