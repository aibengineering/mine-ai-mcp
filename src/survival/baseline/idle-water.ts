import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import { horizontalControlsToward } from "../../navigation/index.js";
import type { ActionRunner } from "../../session/action-runner.js";
import type { Position3 } from "../../utils/index.js";
import { isInWater } from "../perception/body.js";

/** A baseline body owner, released by admission before the new owner writes controls. */
export function attachIdleWaterControl(
  bot: Bot,
  navigation: Pick<NavigationRuntime, "active">,
  runner: ActionRunner,
): Disposable {
  let anchor: Position3 | null = null;
  let ownsControls = false;
  const release = () => {
    anchor = null;
    if (!ownsControls) return;
    ownsControls = false;
    for (const control of ["jump", "forward", "back", "left", "right"] as const) bot.setControlState(control, false);
  };
  const tick = () => {
    if (navigation.active || runner.status().owner !== "idle") {
      // A primitive can be used directly by a scenario, outside action admission.
      // Its controls are already live; relinquish bookkeeping without clearing them.
      ownsControls = false;
      runner.releaseBaseline("idle_water");
      anchor = null;
      return;
    }
    if (!isInWater(bot) && bot.entity.onGround) {
      runner.releaseBaseline("idle_water");
      return;
    }
    if (!isInWater(bot) && anchor === null) return;
    if (!runner.holdBaseline("idle_water", release)) return;
    ownsControls = true;
    anchor ??= { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    const correction = horizontalControlsToward(bot.entity, anchor, 0.05);
    for (const control of ["forward", "back", "left", "right"] as const)
      bot.setControlState(control, correction[control]);
    bot.setControlState("jump", isInWater(bot));
  };
  bot.on("physicsTick", tick);
  return {
    [Symbol.dispose]() {
      bot.off("physicsTick", tick);
      runner.releaseBaseline("idle_water");
    },
  };
}
