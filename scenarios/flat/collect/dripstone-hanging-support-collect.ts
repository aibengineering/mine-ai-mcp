import { ActionRunner, createCollectBlockAction } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const supportCell = new Vec3(0, -54, 0);
  const tipCell = new Vec3(0, -55, 0);
  const support = context.bot.blockAt(supportCell);
  const tip = context.bot.blockAt(tipCell);
  context.log(`HANGING_BEFORE ${JSON.stringify({ support: support?.name, tip: tip?.name, properties: tip?.getProperties(), shapes: tip?.shapes, position: context.bot.entity.position })}`);
  if (support?.name !== "stone" || tip?.name !== "pointed_dripstone" || tip.getProperties().vertical_direction !== "down")
    throw new Error("Supported downward dripstone was not observed before collection.");
  let damage = 0;
  const onDamage = (packet: { entityId: number }) => { if (packet.entityId === context.bot.entity.id) damage += 1; };
  context.bot._client.on("damage_event", onDamage);
  try {
    const result = await new ActionRunner().run(
      createCollectBlockAction(context.bot, context.navigation),
      { block_name: "stone", count: 1, x: 0, y: -54, z: 0, scaffold: false },
      context.signal,
    );
    await context.bot.waitForTicks(20);
    const safelyRefused =
      result.result.status === "failed" &&
      "error" in result.result &&
      result.result.error.includes("NO_REACHABLE_MATCHING_TARGETS") &&
      damage === 0 &&
      context.bot.health === 20 &&
      context.bot.blockAt(supportCell)?.name === "stone" &&
      context.bot.blockAt(tipCell)?.name === "pointed_dripstone";
    return {
      status: safelyRefused ? "succeeded" : "failed",
      detail: JSON.stringify({ result, damage, health: context.bot.health, position: context.bot.entity.position, support: context.bot.blockAt(supportCell)?.name, tip: context.bot.blockAt(tipCell)?.name, navigation: context.pathfinder.summary() }),
    };
  } finally {
    context.bot._client.off("damage_event", onDamage);
  }
};
