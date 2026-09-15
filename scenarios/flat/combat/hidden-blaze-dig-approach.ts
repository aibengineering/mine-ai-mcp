import { Vec3 } from "vec3";
import { hasExposedBody } from "../../../src/world/entity-visibility.ts";
import { observe } from "../../default/nether/hazards/pit.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  await standStill(context);
  await wearArmor(context);
  bot.chat('/summon blaze 0.8 78 -0.3 {NoGravity:1b,PersistenceRequired:1b,Tags:["hidden_charge"]}');
  await observe(bot, () => !!bot.nearestEntity((e) => e.name === "blaze"), "native blaze");
  const blaze = bot.nearestEntity((e) => e.name === "blaze")!;
  const flagIndex = bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
  const charged = () => {
    const flags = blaze.metadata[flagIndex];
    return typeof flags === "number" && (flags & 1) !== 0;
  };
  // Let vanilla begin the charge with sight, then break sight by moving to
  // the recorded lower stance. The controller and its controls remain production code.
  await observe(bot, charged, "native charge before hiding");
  // Hold the witnessed pose so random flight cannot remove the regression's
  // precondition. The charge flag still comes from vanilla's attack goal.
  bot.chat("/data merge entity @e[tag=hidden_charge,limit=1] {NoAI:1b,Motion:[0d,0d,0d]}");
  bot.chat("/tp @e[tag=hidden_charge,limit=1] 0.8 78 -0.3");
  await observe(bot, () => blaze.position.distanceTo(new Vec3(0.8, 78, -0.3)) < 0.2, "recorded blaze pose");
  const start = new Vec3(0.5, 72, 0.5);
  bot.chat(`/tp @s ${start.x} ${start.y} ${start.z}`);
  await observe(bot, () => bot.entity.position.distanceTo(start) < 0.2, "lower stance");
  await standStill(context);
  if (!charged() || hasExposedBody(bot, blaze)) throw new Error("Fixture needs a charged blaze hidden behind terrain");
  let approaches = 0;
  let steps = 0;
  let cleared = false;
  let hiddenChargeTicks = 0;
  const block = new Vec3(0, 73, 1);
  const tick = () => {
    if (charged() && !hasExposedBody(bot, blaze)) hiddenChargeTicks++;
    if (bot.blockAt(block)?.name === "air") cleared = true;
  };
  const unsubscribe = navigation.onEvent((event) => {
    if (event.kind === "run_started") approaches++;
    if (event.kind === "step_completed") steps++;
  });
  bot.on("physicsTick", tick);
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const combat = scenarioCombat1.controller;
  try {
    const outcome = await combat.engage(blaze.id, signal, "pursue");
    const evidence = {
      outcome,
      approaches,
      steps,
      cleared,
      hiddenChargeTicks,
      health: bot.health,
      position: bot.entity.position,
    };
    log(JSON.stringify(evidence));
    return {
      status: outcome.kind === "died" && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    bot.off("physicsTick", tick);
    unsubscribe();
    log(JSON.stringify({ approaches, steps, cleared, hiddenChargeTicks, phase: combat.execution() }));
  }
};
