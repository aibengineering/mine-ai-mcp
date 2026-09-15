import { Vec3 } from "vec3";
import { createNavigationRuntime, createMovements } from "../../../src/navigation/runtime.ts";
import { nearGoal } from "../../../src/navigation/goals/index.ts";
import { IncrementalSearch } from "../../../src/navigation/search/search.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, signal, log }) => {
  await using runtime = createNavigationRuntime(bot);
  const advance = IncrementalSearch.prototype.advance;
  let defer = false;
  // Own the test's search schedule, not the bot's observations: native physics
  // keeps ticking during five ticks of zero-expansion search slices.
  IncrementalSearch.prototype.advance = function (budget) {
    return advance.call(this, defer ? { maximumExpansions: 0 } : budget);
  };
  const results: { impulse: boolean; armed: boolean; airborne: boolean; stale: boolean; completed: boolean }[] = [];
  try {
    for (const impulse of [false, true]) {
      bot.chat("/tp @s 0.687 -39 0.163");
      await bot.waitForTicks(10);
      let stale = false;
      let armed = false;
      let airborne = false;
      const observeFlight = () => {
        airborne ||= !bot.entity.onGround;
      };
      bot.on("physicsTick", observeFlight);
      const stop = new AbortController();
      const unsubscribe = runtime.onEvent((event) => {
        if (event.kind === "search_started" && !armed) {
          armed = true;
          defer = true;
          if (impulse) bot.entity.velocity.set(-0.053, 0.36075, -0.398375);
          void bot.waitForTicks(5).then(() => {
            defer = false;
          });
        }
        if (event.kind === "route_committed") {
          const feet = bot.entity.position.floored();
          const invalid =
            !bot.entity.onGround || !feet.equals(new Vec3(event.plan.start.x, event.plan.start.y, event.plan.start.z));
          stale ||= invalid;
          log(
            JSON.stringify({
              impulse,
              event: "commit",
              start: event.plan.start,
              position: bot.entity.position,
              onGround: bot.entity.onGround,
              invalid,
            }),
          );
        }
      });
      const cancel = impulse ? bot.waitForTicks(30).then(() => stop.abort("observation complete")) : Promise.resolve();
      try {
        const result = await runtime.navigate({
          goal: nearGoal({ x: -4, y: -39, z: 0 }, 0),
          movements: createMovements(bot, { allowDigging: false, scaffolding: false }),
          signal,
          stopSignal: stop.signal,
        });
        const completed = result.status === "completed";
        results.push({ impulse, armed, airborne, stale, completed });
        log(JSON.stringify({ impulse, stale, result, position: bot.entity.position }));
        await cancel;
      } finally {
        unsubscribe();
        bot.off("physicsTick", observeFlight);
        defer = false;
      }
    }
    return {
      status: results.every((r) => r.armed && !r.stale && (r.impulse ? r.airborne : r.completed))
        ? "succeeded"
        : "failed",
      detail: JSON.stringify(results),
    };
  } finally {
    IncrementalSearch.prototype.advance = advance;
  }
};
