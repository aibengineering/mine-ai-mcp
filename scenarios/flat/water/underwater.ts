import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";

const paramsSchema = z.object({
  legs: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]),
  collect: z.number().optional(), cancel: z.boolean().default(false), reject: z.boolean().default(false),
  replan: z.boolean().default(false), backstop: z.boolean().default(false), breathing: z.boolean().default(false),
  holdDepth: z.boolean().default(false),
});

export const run: MineAiScenario = async (context) => {
  const { bot, log, signal } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const runtime = await openRuntime(context, context.scenario.name ?? "underwater");
  const cancel = new AbortController();
  const events: Record<string, number> = {};
  let tick = 0;
  let minAir = 300;
  let minY = bot.entity.position.y;
  let injected = false;
  let reflexSeen = false;
  let changedAtDepth = 0;
  let heldDepth: number | null = null;
  let maxDepthError = 0;
  let obstruction: { x: number; y: number; z: number } | null = null;
  const observe = () => {
    minAir = Math.min(minAir, airSupplyTicks(bot) ?? 300);
    minY = Math.min(minY, bot.entity.position.y);
    if (heldDepth !== null) maxDepthError = Math.max(maxDepthError, Math.abs(bot.entity.position.y - heldDepth));
    if (!reflexSeen && runtime.status().survival.owner.current === "breath_reflex") {
      reflexSeen = true;
      log(JSON.stringify({ firstBreathReflex: bot.entity.position, air: airSupplyTicks(bot), events }));
    }
    if (!injected && bot.entity.position.y < -58.5 && (params.replan || params.backstop)) {
      const at = params.backstop ? bot.entity.position.floored().offset(0, 3, 0) : obstruction;
      if (at) {
        injected = true;
        bot.chat(`/setblock ${at.x} ${at.y} ${at.z} glass`);
        log(JSON.stringify({ injectedObstacle: at }));
      }
    }
    if (params.cancel && bot.entity.position.y < -58.5) cancel.abort("Scenario cancellation at depth");
    if (++tick % 40 === 0) log(JSON.stringify({ position: bot.entity.position, air: airSupplyTicks(bot),
      sand: bot.inventory.items().filter((item) => item.name === "sand").reduce((n, item) => n + item.count, 0), events }));
  };
  const unsubscribe = runtime.navigation.onEvent((event) => {
    if (event.kind === "run_settled") log(JSON.stringify(event));
    events[event.kind] = (events[event.kind] ?? 0) + 1;
    if (event.kind === "dive") events[event.state] = (events[event.state] ?? 0) + 1;
    if (event.kind === "search_started" && injected && event.reason === "start_changed") changedAtDepth++;
    if (event.kind === "route_committed" && params.replan && !injected)
      obstruction = event.plan.steps.find(({ from, to }) => to.y <= -59 && (to.x !== from.x || to.z !== from.z))?.to ?? null;
    if (event.kind === "search_started") events[event.reason] = (events[event.reason] ?? 0) + 1;
  });
  bot.on("physicsTick", observe);
  try {
    if (params.collect !== undefined) {
      const action = runtime.actions.find((action) => action.name === "collect_block")!;
      const output = await runtime.run(action, { block_name: "sand", count: params.collect, scaffold: false }, signal);
      log(JSON.stringify(output));
      if (output.result.status !== "succeeded") return { status: "failed", detail: JSON.stringify(output) };
      if (bot.inventory.items().filter((item) => item.name === "sand").reduce((n, item) => n + item.count, 0) < params.collect)
        return { status: "failed", detail: "Collection returned without the native inventory gain" };
    }
    for (const [x, y, z] of params.legs) {
      heldDepth = params.holdDepth && bot.entity.position.floored().y === y ? y + 0.2 : null;
      const action = runtime.actions.find((action) => action.name === "navigate")!;
      const output = await runtime.run(action, { x, y, z, range: 0.1, dig: false, scaffold: false }, AbortSignal.any([signal, cancel.signal]));
      log(JSON.stringify(output));
      if (params.reject || params.cancel || params.backstop) {
        if (output.result.status === "succeeded") return { status: "failed", detail: "Unsafe/cancelled request reported success" };
      } else if (output.result.status !== "succeeded" || bot.entity.position.floored().x !== x ||
        bot.entity.position.floored().y !== y || bot.entity.position.floored().z !== z)
        return { status: "failed", detail: `Arrival at ${x},${y},${z} failed: ${JSON.stringify(output)}` };
      heldDepth = null;
    }
    // Keep the real runtime alive to observe the action-to-idle survival handoff.
    for (let waited = 0; waited < 240 && ((airSupplyTicks(bot) ?? 300) < 300 ||
      bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "water"); waited++) await bot.waitForTicks(1);
    if (params.breathing && (!events.breathing || !events.resumed || reflexSeen))
      return { status: "failed", detail: `Planned breathing was not proved: ${JSON.stringify({ events, reflexSeen })}` };
    if (params.backstop && (!injected || !reflexSeen)) return { status: "failed", detail: "Backstop takeover was not observed" };
    if (params.replan && (!injected || !events.world_changed || changedAtDepth > 0)) return { status: "failed", detail: `Depth replan injection=${injected}, world changes=${events.world_changed}, start changes=${changedAtDepth}` };
    if (params.holdDepth && maxDepthError > 0.35) return { status: "failed", detail: `Midwater turn left its depth band by ${maxDepthError} blocks` };
    return { status: bot.health === 20 && (airSupplyTicks(bot) === 300 ||
      (airSupplyTicks(bot) === null && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "air")) ? "succeeded" : "failed",
      detail: JSON.stringify({ minY, minAir, health: bot.health, air: airSupplyTicks(bot), events, reflexSeen, injected, changedAtDepth, maxDepthError }) };
  } finally {
    bot.off("physicsTick", observe);
    unsubscribe();
    await runtime.close();
  }
};
