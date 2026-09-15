import { SupportedPositionHold } from "../../../../src/navigation/steering/supported-position.ts";
import { declaredStart, standStill } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../../src/scenario-evidence.ts";

/** Isolate the physical hold on the recorded ledge with both measured cube impulses. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  const start = declaredStart(context);
  await bot.waitForChunksToLoad();
  if (bot.blockAt(start.offset(0, -0.01, 0))?.name !== "basalt") throw new Error("Recorded basalt support changed");
  if (!(await standStill(context))) throw new Error("Cannot settle on recorded ledge");
  // A shielded controller now defends in place when no safer stance exists.
  // An invulnerable target would make that fight endless. This fixture owns
  // the two physical impulses; native target selection has separate trials.
  const hold = new SupportedPositionHold(bot, navigation.world);
  let ticks = 0;
  let lava = false;
  let minimumY = bot.entity.position.y;
  const samples: unknown[] = [];
  const tick = () => {
    ticks++;
    if (ticks === 8) bot.entity.velocity.set(0.392125, 0.36075, 0.07875);
    if (ticks === 19) bot.entity.velocity.set(0.353375, 0.36075, 0.195625);
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    minimumY = Math.min(minimumY, bot.entity.position.y);
    samples.push({
      ticks,
      position: bot.entity.position.clone(),
      velocity: bot.entity.velocity.clone(),
      onGround: bot.entity.onGround,
      controls: Object.fromEntries(
        (["forward", "back", "left", "right", "sneak"] as const).map((key) => [key, bot.getControlState(key)]),
      ),
    });
    hold.tick();
  };
  bot.on("physicsTick", tick);
  try {
    while (ticks < 60) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await hold.stop();
    await bot.waitForTicks(10);
    return {
      status: ticks >= 60 && !lava && minimumY >= 33 && bot.entity.onGround ? "succeeded" : "failed",
      detail: JSON.stringify({
        lava,
        minimumY,
        ticks,
        evidenceFile: await writeScenarioEvidence(context, "generated-basalt-combat-knockback.json", { samples }),
      }),
    };
  } finally {
    hold.release();
    bot.off("physicsTick", tick);
  }
};
