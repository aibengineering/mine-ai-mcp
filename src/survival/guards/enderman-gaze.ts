import type { Bot } from "mineflayer";
import type { CombatEngagement } from "../control/combat/contract.js";
import { endermanGazeRisk } from "../perception/combat/gaze.js";

/** Correct both requested looks and an idle gaze as Endermen move into it. */
export function attachEndermanGazeControl(bot: Bot, engagement: () => CombatEngagement | null): Disposable {
  const look = bot.look;
  const safePitch = (yaw: number, pitch: number) => {
    const active = engagement();
    const selected = active?.kind === "mob" ? active.targetId : undefined;
    const unsafe = (candidate: number) => endermanGazeRisk(bot, bot.entity.position, yaw, candidate, selected);
    if (!unsafe(pitch)) return pitch;
    // Retain movement yaw. A cliff can put an Enderman below us, so test the
    // downward alternative as well instead of assuming the ground is safe.
    return [-Math.PI / 2, Math.PI / 2, 0].find((candidate) => !unsafe(candidate)) ?? pitch;
  };
  const guarded: Bot["look"] = (yaw, pitch, force) => look.call(bot, yaw, safePitch(yaw, pitch), force);
  bot.look = guarded;
  const tick = () => {
    const pitch = safePitch(bot.entity.yaw, bot.entity.pitch);
    if (pitch !== bot.entity.pitch) void look.call(bot, bot.entity.yaw, pitch, true);
  };
  bot.on("physicsTick", tick);
  return {
    [Symbol.dispose]() {
      bot.off("physicsTick", tick);
      if (bot.look === guarded) bot.look = look;
    },
  };
}
