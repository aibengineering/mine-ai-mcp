import { Vec3 } from "vec3";
import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  const details: string[] = [];
  for (const fire of ["fire", "soul_fire"] as const) {
    for (const dynamic of [false, true]) {
      bot.chat("/fill -2 -60 -3 14 -59 3 air");
      bot.chat(`/tp ${bot.username} 0.5 -60 0.5`);
      bot.chat(`/setblock 6 -61 0 ${fire === "fire" ? "netherrack" : "soul_soil"}`);
      if (!dynamic) bot.chat(`/setblock 6 -60 0 ${fire}`);
      await bot.waitForTicks(5);
      if (!(await standStill(context))) return { status: "failed", detail: "Fixture did not settle" };
      const initialFire = bot.blockAt(new Vec3(6, -60, 0))?.name;
      if (!dynamic && initialFire !== fire)
        return {
          status: "failed",
          detail: `Fixture expected ${fire}, observed ${initialFire}, support ${bot.blockAt(new Vec3(6, -61, 0))?.name}`,
        };
      let contacts = 0;
      let samples = 0;
      let injected = false;
      let replanned = false;
      const observe = () => {
        samples++;
        const p = bot.entity.position;
        for (let x = Math.floor(p.x - 0.3 + 1e-7); x <= Math.floor(p.x + 0.3 - 1e-7); x++)
          for (let y = Math.floor(p.y + 1e-7); y <= Math.floor(p.y + 1.8 - 1e-7); y++)
            for (let z = Math.floor(p.z - 0.3 + 1e-7); z <= Math.floor(p.z + 0.3 - 1e-7); z++) {
              const name = bot.blockAt(new Vec3(x, y, z))?.name;
              if (name === "fire" || name === "soul_fire") contacts++;
            }
      };
      bot.on("physicsTick", observe);
      const unsubscribe = navigation.onEvent((event) => {
        if (event.kind === "search_started" && event.reason === "world_changed") replanned = true;
        if (dynamic && !injected && event.kind === "step_completed" && bot.entity.position.x >= 2) {
          injected = true;
          bot.chat(`/setblock 6 -60 0 ${fire}`);
        }
      });
      const before = bot.health;
      const result = await new ActionRunner()
        .run(
          createNavigateAction(bot, navigation),
          { x: 12, y: -60, z: 0, range: 0, dig: false, scaffold: false },
          signal,
        )
        .finally(() => {
          bot.off("physicsTick", observe);
          unsubscribe();
        });
      const present = bot.blockAt(new Vec3(6, -60, 0))?.name === fire;
      const passed =
        result.result.status === "succeeded" &&
        contacts === 0 &&
        bot.health === before &&
        present &&
        (!dynamic || injected);
      const detail = JSON.stringify({
        fire,
        dynamic,
        status: result.result.status,
        contacts,
        samples,
        before,
        after: bot.health,
        present,
        injected,
        replanned,
        end: bot.entity.position,
      });
      details.push(detail);
      context.log(detail);
      if (!passed) return { status: "failed", detail: details.join("; ") };
    }
  }
  return { status: "succeeded", detail: details.join("; ") };
};
