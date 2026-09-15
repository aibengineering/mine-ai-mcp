import { huntMobResultSchema } from "@aibengineering/mine-ai-mcp";
import { declaredEntitiesArranged, openRuntime } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { arrange, canopy } from "./pit.ts";
import { watch } from "./observe.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await arrange(context, canopy);
  await declaredEntitiesArranged(context);
  const target = Object.values(bot.entities).find((e) => e.name === "enderman")!;
  const targetStart = target.position.clone();
  const pearlId = bot.registry.itemsByName.ender_pearl!.id;
  const initialPearls = bot.inventory.count(pearlId, null);
  const runtime = await openRuntime(context, "canopy-gap-hunt");
  const observation = watch(bot, canopy, () => runtime.status().activeAction?.action);
  try {
    try {
      // All administration ends here: only the ordinary hunt and return own movement/combat.
      const huntAction = runtime.actions.find((a) => a.name === "collect_mob_drop")!;
      const hunt = await runtime.run(huntAction, { mob_name: "enderman", drop_name: "ender_pearl", count: 1 }, signal);
      const navigate = runtime.actions.find((a) => a.name === "navigate")!;
      const recovery = await runtime.run(
        navigate,
        { x: canopy.refuge.x, y: canopy.refuge.y, z: canopy.refuge.z, range: 1 },
        signal,
      );
      await bot.waitForTicks(100);
      const result = huntMobResultSchema.safeParse(hunt.result);
      const gained = bot.inventory.count(pearlId, null) - initialPearls;
      const evidence = observation.evidence();
      const remaining = bot.entity.position.distanceTo(canopy.refuge.offset(0.5, 0, 0.5));
      const selected =
        result.success &&
        result.data.hunt.targets.some((t) => t.id === target.id) &&
        result.data.hunt.targetsEngaged > 0;
      const attacked = evidence.damage.some((d) => d.entityId === target.id && d.attackerId === bot.entity.id);
      const passed =
        initialPearls === 0 &&
        targetStart.distanceTo(canopy.target.offset(0.5, 0, 0.5)) < 2 &&
        gained >= 1 &&
        evidence.deaths === 0 &&
        !evidence.lava &&
        evidence.maximumUnsupportedDescent <= 3 &&
        bot.health > 0 &&
        remaining <= 2 &&
        bot.game.dimension === "the_nether";
      return {
        status: passed ? "succeeded" : "failed",
        detail: JSON.stringify({
          verdict: passed ? "pearl returned alive" : "acquisition or return incomplete",
          selected,
          attacked,
          serverArmorConfirmed: true,
          targetId: target.id,
          targetStart,
          initialPearls,
          gained,
          remaining,
          finalHealth: bot.health,
          hunt,
          recovery,
          ...evidence,
        }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    observation.close();
  }
};
