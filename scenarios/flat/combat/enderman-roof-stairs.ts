import assert from "node:assert/strict";
import { huntMobResultSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { CombatPosition } from "../../../src/survival/positioning/combat/position.ts";
import { observedEyeHeight } from "../../../src/world/block-visibility.ts";
import { clearCombatRay } from "../../../src/world/entity-geometry.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { ScenarioCombat } from "../../src/combat.ts";

/** The native attacker remains AI-enabled throughout provocation and construction. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  assert.ok(await standStill(context));
  await wearArmor(context);
  const target = bot.nearestEntity((entity) => entity.name === "enderman")!;
  assert.ok(target);
  const start = bot.entity.position.clone();
  using responseOwner1 = new ScenarioCombat(bot, navigation);
  const position = new CombatPosition(
    bot,
    navigation,
    target,
    new Set(),
    responseOwner1.perception,
    () => responseOwner1.controller.policy.combat,
    responseOwner1.survival.answered,
  );
  const before = position.planRoof({
    kind: "provoke",
    targetEye: target.position.offset(0, 2.55, 0),
    eyeHeight: observedEyeHeight(bot.entity),
  });
  let combat!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "enderman-provoke-before-roof", {
    createCombatController: (...dependencies) => (combat = createCombatController(...dependencies)),
  });
  const creepy = bot.registry.entitiesByName.enderman.metadataKeys!.indexOf("creepy");
  let hostileAt: number | null = null;
  let firstPlacementAt: number | null = null;
  let completedAt: number | null = null;
  let gazeAfterRoof: boolean | null = null;
  let minimumHealth = bot.health;
  const remove = combat.onDecision((event) => {
    if (event.kind === "roof_provoked") {
      context.log(`Native hostility at preparation: ${String(Reflect.get(target.metadata, creepy))}`);
      hostileAt = Date.now();
    }
    if (event.kind === "roof_prepared" && event.stopped === null) {
      completedAt = Date.now();
      const eye = bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0);
      gazeAfterRoof = clearCombatRay(bot.world, eye, target.position.offset(0, 2.55, 0));
    }
  });
  const blockChanged: Parameters<typeof bot.on<"blockUpdate">>[1] = (oldBlock, block) => {
    if (block?.name === "cobblestone" && oldBlock?.name !== "cobblestone" && firstPlacementAt === null)
      firstPlacementAt = Date.now();
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  bot.on("blockUpdate", blockChanged);
  bot.on("physicsTick", tick);
  try {
    const hunt = runtime.actions.find((action) => action.name === "collect_mob_drop")!;
    const output = await runtime.run(hunt, { mob_name: "enderman", drop_name: "ender_pearl", count: 1 }, signal);
    const result = huntMobResultSchema.parse(output.result);
    const evidence = {
      start,
      before,
      hostileAt,
      firstPlacementAt,
      completedAt,
      buildMs: completedAt !== null && hostileAt !== null ? completedAt - hostileAt : null,
      gazeAfterRoof,
      minimumHealth,
      output,
    };
    const evidenceFile = await writeScenarioEvidence(context, "enderman-roof-stairs.json", evidence);
    const passed = result.hunt.targetDeathsObserved === 1 && minimumHealth >= 10;
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        hostileAt,
        firstPlacementAt,
        completedAt,
        gazeAfterRoof,
        minimumHealth,
        targetDeaths: result.hunt.targetDeathsObserved,
        retargets: result.hunt.retargets,
        evidenceFile,
      }),
    };
  } finally {
    bot.off("blockUpdate", blockChanged);
    bot.off("physicsTick", tick);
    remove();
    await runtime.close();
  }
};
