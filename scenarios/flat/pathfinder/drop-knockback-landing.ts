import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { Vec3 } from "vec3";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Retain the fortress fireball's impulse; let the native physics apply it during the real drop. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await standStill(context);
  let injected = false;
  let dropping = false;
  let lava = false;
  const release = navigation.onEvent((event) => {
    if (event.kind === "step_started" && event.movement === "drop") dropping = true;
  });
  const tick = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    if (!injected && dropping && !bot.entity.onGround && bot.entity.position.z < -0.25) {
      injected = true;
      // 1788848723126 in architecture-qualification trial 3. The controller
      // had latched all controls off for the coast and never corrected again.
      bot._client.emit("entity_velocity", {
        entityId: bot.entity.id,
        velocity: { x: 1642, y: 2201, z: -596 },
      });
    }
  };
  bot.on("physicsTick", tick);
  try {
    const outcome = await navigation.navigate({
      movements: createMovements(bot, { allowDigging: false, scaffolding: false, allowParkour: false }),
      goal: exactBlockGoal(new Vec3(0, -56, -1)),
      signal,
    });
    await bot.waitForTicks(20);
    return {
      status:
        injected && !lava && bot.health === 20 && bot.entity.onGround && bot.entity.position.y >= -56
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ outcome, injected, lava, health: bot.health, position: bot.entity.position }),
    };
  } finally {
    bot.off("physicsTick", tick);
    release();
  }
};
