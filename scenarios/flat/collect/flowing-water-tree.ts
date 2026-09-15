import { COLLECT_BLOCK } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { droppedItemName } from "../../../src/world/item-pickup.ts";

export async function prepare({ bot, scenario }: MineAiScenarioContext): Promise<void> {
  // Finish arranging native flow before placing the bot at the incident start.
  await bot.waitForTicks(100);
  const moved = new Promise<void>((resolve) => bot.once("forcedMove", () => resolve()));
  const [x, y, z] = scenario.players[0]!.pos!;
  bot.chat(`/tp @s ${x} ${y} ${z}`);
  await moved;
}

/** Observe the production collection and reflexes without driving the bot. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal, log } = context;
  const { tree_base, expect_safe_partial, ...request } = context.scenario.params;
  const [treeX, treeY, treeZ] = z.tuple([z.number(), z.number(), z.number()]).parse(tree_base);
  await using runtime = await openRuntime(context, "flowing-water-tree");
  const collect = runtime.actions.find((action) => action.name === COLLECT_BLOCK);
  if (!collect) throw new Error("The scenario requires collect_block.");
  let ticks = 0;
  const started = Date.now();
  const frame = () => {
    const trunk = Array.from(
      { length: 6 },
      (_, height) => bot.blockAt(new Vec3(treeX, treeY + height, treeZ))?.name ?? null,
    );
    return {
      ticks,
      position: bot.entity.position,
      onGround: bot.entity.onGround,
      feet: bot.blockAt(bot.entity.position)?.name,
      waterLevel: bot.blockAt(bot.entity.position)?.getProperties().level,
      trunkLogs: trunk.filter((name) => name === "oak_log").length,
      unloadedTrunkCells: trunk.filter((name) => name === null).length,
      health: bot.health,
      inventory: bot.inventory.items().map(({ name, count }) => ({ name, count })),
      logDrops: Object.values(bot.entities).flatMap((entity) =>
        entity.isValid && droppedItemName(entity) === "oak_log"
          ? [
              {
                id: entity.id,
                position: entity.position,
                velocity: entity.velocity,
                onGround: entity.onGround,
                block: bot.blockAt(entity.position)?.name,
              },
            ]
          : [],
      ),
      digging: bot.targetDigBlock?.position ?? null,
      controls: Object.fromEntries(
        (["forward", "back", "left", "right", "jump", "sneak", "sprint"] as const).map((control) => [
          control,
          bot.getControlState(control),
        ]),
      ),
      owner: runtime.status().owner,
    };
  };
  const tick = () => {
    ticks++;
    if (ticks % 20 === 0) log(`TREE_TICK ${JSON.stringify(frame())}`);
  };
  const stopObserving = runtime.navigation.onEvent((event) => {
    if (event.kind !== "search_slice") log(`TREE_NAV ${JSON.stringify(event)}`);
    if (event.kind === "goal_arrived") log(`TREE_ARRIVAL ${JSON.stringify(frame())}`);
  });
  bot.on("physicsTick", tick);
  try {
    log(`TREE_START ${JSON.stringify(frame())}`);
    // Collection must choose its approach. The player may start on dry ground.
    const water = bot.blockAt(new Vec3(treeX, treeY + 1, treeZ - 1));
    log(`TREE_WATER ${JSON.stringify({ name: water?.name, level: water?.getProperties().level })}`);
    if (water?.name !== "water" || Number(water.getProperties().level) === 0)
      throw new Error("The tree's approach cell must contain flowing water.");
    const output = await runtime.run(collect, request, signal);
    log(`TREE_RESULT ${JSON.stringify(output.result)}`);
    const gained = bot.inventory.items().filter((item) => item.name === "oak_log")
      .reduce((sum, item) => sum + item.count, 0);
    const safePartial = output.result.status === "partial" && "error" in output.result &&
      /liquid isolation needs/.test(String(output.result.error)) && gained > 0 && gained < 6 &&
      bot.health === 20 && bot.entity.position.distanceTo(new Vec3(treeX, treeY, treeZ)) < 16 &&
      Date.now() - started < 45_000;
    return {
      status: (expect_safe_partial === true ? safePartial : output.result.status === "succeeded") ? "succeeded" : "failed",
      detail: JSON.stringify({ result: output.result, final: frame() }),
    };
  } finally {
    stopObserving();
    bot.off("physicsTick", tick);
    await runtime.captureIncident();
  }
}
