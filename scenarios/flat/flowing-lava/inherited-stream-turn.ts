import { MineflayerBot, mineflayerBotSurface } from "../../../src/navigation/mineflayer/bot.ts";
import type { PlannedStep } from "../../../src/navigation/movements/movement.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Replay the recorded handoff into the production actuator with real server collisions. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  if (!(await standStill(context))) throw new Error("The recorded landing did not settle.");
  await bot.waitForTicks(80);
  const actuator = new MineflayerBot(mineflayerBotSurface(bot), navigation.world);
  const step: PlannedStep = {
    id: "recorded-west-step",
    kind: "step_up",
    from: { x: 0, y: -42, z: 0 },
    to: { x: -1, y: -41, z: 0 },
    validArrivals: [{ x: -1, y: -41, z: 0 }],
    preconditions: [],
    effects: [],
    operations: [{ kind: "move", movement: "step_up", target: { x: -0.5, y: -41, z: 0.5 } }],
    cost: { expectedTicks: 20, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 20 },
  };
  await bot.look(-2.974041151924596, 0, true);
  // The final native velocity and observed displacement from request 205 at
  // 04:04:17.229Z. Only this initial state is injected, not the subsequent path.
  bot.entity.velocity.set(0.011574738831951432, -0.0784000015258789, 0.10747167248269794);
  let snapshot = {
    ...actuator.movementSnapshot(),
    velocity: { x: 0.012719493221936773, y: -0.024424088213685025, z: 0.11810073899198414 },
  };
  let contact = false;
  let minimumHealth = bot.health;
  const observe = () => {
    snapshot = actuator.movementSnapshot();
    contact ||= isInLava(bot) || isBurning(bot);
    minimumHealth = Math.min(minimumHealth, bot.health);
    const controls = Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sneak"] as const).map((key) => [key, bot.getControlState(key)]),
    );
    log(`STREAM_TURN_TICK ${JSON.stringify({ ...snapshot, controls, contact, health: bot.health })}`);
  };
  bot.on("physicsTick", observe);
  let arrived = false;
  try {
    log(`STREAM_TURN_START ${JSON.stringify(snapshot)}`);
    const preparation = await actuator.prepareMovement(
      step,
      { runId: "replay", planId: "recorded", stepId: step.id, attempt: 1 },
      signal,
      { end: "continuous" },
      () => snapshot,
    );
    if (preparation.kind !== "ready") throw new Error("Expected the recorded step to require movement.");
    actuator.applyMovementControls(preparation.controller.initialControls);
    for (;;) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      const tick = preparation.controller.advance(snapshot);
      if (tick.kind !== "running") {
        arrived = tick.kind === "arrived";
        break;
      }
      if (tick.steeringTarget) actuator.applyMovementSteering(tick.steeringTarget);
      actuator.applyMovementControls(tick.controls);
    }
    actuator.clearOwnedControls();
    await bot.waitForTicks(40);
    return {
      status: arrived && !contact && minimumHealth === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ arrived, contact, minimumHealth, final: bot.entity.position }),
    };
  } finally {
    bot.off("physicsTick", observe);
    actuator.clearOwnedControls();
  }
};
