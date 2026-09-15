import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { WorldBlock } from "../../../src/world/placement.ts";

export async function prepare({ bot }: MineAiScenarioContext): Promise<void> {
  await bot.waitForTicks(100);
  const moved = new Promise<void>((resolve) => bot.once("forcedMove", () => resolve()));
  bot.chat("/tp @s 0.5 -59 0.5");
  await moved;
  const water = bot.blockAt(new Vec3(2, -59, 0));
  if (water?.name !== "water" || Number(water.getProperties().level) === 0)
    throw new Error("Flowing water must cover the target log.");
}

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await using runtime = await openRuntime(context, "preserve-collected-water-plug");
  const collect = runtime.actions.find((action) => action.name === "collect_block");
  if (!collect) throw new Error("The collect action is required.");
  const logId = bot.registry.itemsByName.oak_log!.id;
  const before = bot.inventory.count(logId, null);
  const placements: { item: string; position: Vec3 }[] = [];
  const observe = (oldBlock: WorldBlock | null, block: WorldBlock | null) => {
    if (oldBlock?.name === "water" && block && block.boundingBox === "block")
      placements.push({ item: block.name, position: block.position.clone() });
  };
  bot.on("blockUpdate", observe);
  try {
    const output = await runtime.run(
      collect,
      { block_name: "logs", count: 1, x: 2, y: -60, z: 0, scaffold: false },
      context.signal,
    );
    const after = bot.inventory.count(logId, null);
    return {
      status:
        output.result.status === "succeeded" && after === before + 1 &&
        placements.some(({ item }) => item === "dirt") && !placements.some(({ item }) => item === "oak_log")
          ? "succeeded" : "failed",
      detail: JSON.stringify({ result: output.result, before, after, placements, health: bot.health }),
    };
  } finally {
    bot.off("blockUpdate", observe);
  }
};
