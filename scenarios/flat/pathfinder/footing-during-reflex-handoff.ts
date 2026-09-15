import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import { ReflexDriver } from "../../../src/survival/control/driver.ts";
import { attachFootingReflex } from "../../../src/survival/reflexes/footing.ts";
import { FootingRecovery } from "../../../src/survival/responses/footing.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

/** Replay the physical impulse with a lower reflex already waiting for route cleanup. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await standStill(context);
  const runner = new ActionRunner();
  await using recovery = new FootingRecovery(bot, navigation.world);
  await using driver = new ReflexDriver(bot, runner);
  await using _reflex = attachFootingReflex(
    driver,
    { activeEngagement: () => null },
    recovery,
    navigation.releaseForTakeover,
  );
  let injected = false;
  let lowerReleased = false;
  let airborneTakeover = false;
  let minimumHealth = bot.health;
  let minimumY = bot.entity.position.y;
  let lower: Promise<boolean> | null = null;
  const samples: unknown[] = [];
  const tick = () => {
    const status = runner.status();
    if (!injected && status.owner === "foreground" && !bot.entity.onGround && bot.entity.position.y > -39.9) {
      const admission = runner.claim("hostile_reflex", "Fixture hostile contact during ascent", async (handoff) => {
        lowerReleased = handoff.aborted;
        return { value: lowerReleased, continuation: { kind: "return" as const, reason: null } };
      });
      if (admission.kind !== "claimed") throw new Error("The fixture hostile handoff must be admitted.");
      lower = admission.outcome;
      injected = true;
      bot._client.emit("entity_velocity", { entityId: bot.entity.id, velocity: { x: -2689, y: 2886, z: 1667 } });
    }
    if (!injected) return;
    airborneTakeover ||=
      status.activeAction?.action === "recover_footing" && status.owner === "takeover" && !bot.entity.onGround;
    minimumHealth = Math.min(minimumHealth, bot.health);
    minimumY = Math.min(minimumY, bot.entity.position.y);
    samples.push({
      position: bot.entity.position.clone(),
      ground: bot.entity.onGround,
      owner: status.owner,
      action: status.activeAction?.action,
      footing: recovery.snapshot()?.phase,
    });
  };
  bot.on("physicsTick", tick);
  try {
    const output = await runner.run(
      createNavigateAction(bot, navigation),
      { x: 2, y: -39, z: 0, range: 0, scaffold: false },
      signal,
    );
    if (lower) await lower;
    await bot.waitForTicks(20);
    return {
      status:
        injected && lowerReleased && minimumHealth === 20 && minimumY >= -40 && bot.entity.onGround
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        output,
        injected,
        lowerReleased,
        airborneTakeover,
        minimumHealth,
        minimumY,
        evidenceFile: await writeScenarioEvidence(context, "footing-during-reflex-handoff.json", { samples }),
      }),
    };
  } finally {
    bot.off("physicsTick", tick);
  }
};
