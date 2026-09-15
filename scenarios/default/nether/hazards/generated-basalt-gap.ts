import { writeScenarioEvidence } from "../../../src/scenario-evidence.ts";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createMovements, nearGoal } from "../../../../src/navigation/index.ts";
import { declaredStart, standStill, wearArmor } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";

/** Isolate the exact generated gap crossed during the wounded pack retreat. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  const params = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("cross") }),
      z.object({ kind: z.literal("cancel_gap"), atX: z.number() }),
      z.object({ kind: z.literal("cancel_drop") }),
      z.object({ kind: z.literal("magma_gap") }),
      z.object({ kind: z.literal("knockback_drop") }),
    ])
    .parse(context.scenario.params ?? { kind: "cross" });
  const cancel = new AbortController();
  const start = declaredStart(context);
  const goal =
    params.kind === "knockback_drop"
      ? { x: 199, y: 47, z: -21 }
      : params.kind === "magma_gap"
        ? { x: 199, y: 49, z: -18 }
        : params.kind === "cancel_drop"
          ? { x: 204, y: 48, z: -18 }
          : { x: params.kind === "cross" ? 203 : 201, y: 49, z: -17 };
  await bot.waitForChunksToLoad();
  if (!["basalt", "blackstone"].includes(bot.blockAt(start.offset(0, -1, 0))?.name ?? ""))
    throw new Error(`The native takeoff block is not safe support at ${start}.`);
  const geometry: Array<{ position: Vec3; block: string | undefined }> = [];
  for (let x = Math.floor(start.x) - 1; x <= goal.x + 1; x++)
    for (let z = Math.min(Math.floor(start.z), goal.z) - 1; z <= Math.max(Math.floor(start.z), goal.z) + 1; z++)
      for (let y = goal.y - 3; y <= start.y + 2; y++) {
        const position = new Vec3(x, y, z);
        geometry.push({ position, block: bot.blockAt(position)?.name });
      }
  if (!(await standStill(context))) throw new Error("Could not settle on the natural launch block.");
  await wearArmor(context);
  const samples: unknown[] = [];
  const steps: unknown[] = [];
  let magma = false;
  let lava = false;
  let minimumHealth = bot.health;
  let minimumY = start.y;
  let impulseApplied = false;
  const tick = () => {
    const support = bot.blockAt(bot.entity.position.offset(0, -0.1, 0))?.name;
    magma ||= bot.entity.onGround && support === "magma_block";
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    minimumHealth = Math.min(minimumHealth, bot.health);
    minimumY = Math.min(minimumY, bot.entity.position.y);
    samples.push({
      position: bot.entity.position.clone(),
      velocity: bot.entity.velocity.clone(),
      onGround: bot.entity.onGround,
      support,
      controls: Object.fromEntries(
        ["forward", "jump", "sneak"].map((key) => [key, bot.getControlState(key as "forward" | "jump" | "sneak")]),
      ),
    });
    // Replay the measured native cube impulse from the fatal pack regression.
    // This isolates landing/cancellation mechanics; it is not a native combat trial.
    if (params.kind === "knockback_drop" && !impulseApplied && bot.entity.position.y < 47.6) {
      impulseApplied = true;
      bot.entity.velocity.set(-0.263375, -0.376625, -0.300875);
      cancel.abort("recorded cube impulse during cancelled descent");
    }
    // Registered before navigation's physics listener, matching combat's contact observer.
    if (
      (params.kind === "cancel_gap" && bot.entity.position.x >= params.atX) ||
      (params.kind === "cancel_drop" && !bot.entity.onGround && bot.entity.position.y < start.y)
    )
      cancel.abort("hostile entered melee reach at the launch lip");
  };
  bot.on("physicsTick", tick);
  const stop = navigation.onEvent((e) => steps.push(e));
  try {
    const route = await navigation.navigate({
      movements: createMovements(bot),
      goal: nearGoal(goal, 0.1),
      signal,
      stopSignal: cancel.signal,
    });
    await bot.waitForTicks(20);
    return {
      status:
        (params.kind === "cross" || params.kind === "magma_gap"
          ? route.status === "completed"
          : cancel.signal.aborted && route.status === "stopped") &&
        bot.entity.onGround &&
        minimumHealth === 20 &&
        !lava &&
        !magma &&
        (params.kind !== "knockback_drop" || (impulseApplied && minimumY >= 47))
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        route,
        cancelled: cancel.signal.aborted,
        minimumHealth,
        minimumY,
        impulseApplied,
        lava,
        magma,
        evidenceFile: await writeScenarioEvidence(context, "generated-basalt-gap.json", { samples, geometry, steps }),
      }),
    };
  } finally {
    stop();
    bot.off("physicsTick", tick);
  }
};
