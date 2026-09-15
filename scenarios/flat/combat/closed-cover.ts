import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { awaitEncounters, describe } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "closed-cover");
  try {
    // Longer than the former thirty-second hide cooldown. Cover must remain
    // effective because it is still closed, rather than because time remains.
    for (let tick = 0; tick < 660; tick += 1) {
      signal.throwIfAborted();
      const wallsIntact = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([x, z]) =>
        [-60, -59].every(y => bot.blockAt(new Vec3(x!, y, z!))?.name === "nether_bricks"));
      if (bot.health < 20 || !wallsIntact || bot.entity.position.distanceTo(new Vec3(0.5, -60, 0.5)) > 0.2) {
        return { status: "failed", detail: `Closed shelter lost: health ${bot.health}, walls intact ${wallsIntact}, position ${bot.entity.position}.` };
      }
      await bot.waitForTicks(1);
    }

    // The fixture opens the shelter; ordinary threat observation must respond
    // without waiting out another cooldown or requiring a model action.
    bot.chat("/fill 1 -60 0 1 -59 0 air");
    const encounters = await awaitEncounters(context, runtime, 1, 400);
    const killed = encounters.some((encounter) => encounter.outcome === "target_died");
    return {
      status: killed ? "succeeded" : "failed",
      detail: `Held closed cover for 660 ticks, then opened it: ${encounters.map(describe).join(" | ")}`,
    };
  } finally {
    await runtime.close();
  }
};
