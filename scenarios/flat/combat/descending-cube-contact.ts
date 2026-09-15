import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { meleeDistance } from "../../../src/survival/weapons/melee.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Pause the recorded airborne contact, then let the native cube descend and fight. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await standStill(context);
  await wearArmor(context);
  // The pack death began with the large cube six blocks overhead, horizontally
  // in contact. Pausing that pose isolates admission from server packet timing.
  bot.chat('/summon magma_cube -1.9 -53.9 3.4 {Size:3,NoAI:1b,NoGravity:1b,Tags:["descending_probe"]}');
  while (!signal.aborted && !bot.nearestEntity((entity) => entity.name === "magma_cube")) await bot.waitForTicks(1);
  signal.throwIfAborted();
  const cube = bot.nearestEntity((entity) => entity.name === "magma_cube")!;
  let combat!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "descending-cube-contact", {
    createCombatController: (...dependencies) => (combat = createCombatController(...dependencies)),
  });
  let guarded = 0;
  let hurt = 0;
  const flagsIndex = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const tick = () => {
    const flags = bot.entity.metadata[flagsIndex];
    if (
      combat.activeEngagement()?.targetId === cube.id &&
      meleeDistance(bot, cube) > 3 &&
      typeof flags === "number" &&
      (flags & 3) === 3
    )
      guarded++;
  };
  const onHurt = (entity: typeof bot.entity) => {
    if (entity.id === bot.entity.id) hurt++;
  };
  bot.on("physicsTick", tick);
  bot.on("entityHurt", onHurt);
  try {
    await bot.waitForTicks(20);
    const guardedBeforeDescent = guarded;
    bot.chat("/data merge entity @e[tag=descending_probe,limit=1] {NoAI:0b,NoGravity:0b}");
    while (!signal.aborted && bot.health > 0 && cube.isValid) await bot.waitForTicks(1);
    signal.throwIfAborted();
    return {
      status: bot.health > 0 && !cube.isValid ? "succeeded" : "failed",
      detail: JSON.stringify({ guardedBeforeDescent, health: bot.health, hurt, targetGone: !cube.isValid }),
    };
  } finally {
    bot.off("physicsTick", tick);
    bot.off("entityHurt", onHurt);
    await runtime.close();
  }
};
