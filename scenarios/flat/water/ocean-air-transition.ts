import { z } from "zod";
import { Vec3 } from "vec3";
import { createMovements } from "../../../src/navigation/index.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { STANDING_EYE_HEIGHT } from "../../../src/world/block-visibility.ts";
import { waitForPhysicsTicks } from "../../../src/utils/physics-ticks.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

const cell = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const paramsSchema = z.object({ destination: cell, barriers: z.array(cell).min(1) });
const REQUEST_LIMIT_MS = 10_000;

/** Expected refusal: deliberate ocean/air breaches remain unsupported by default navigation. */
export const run: MineAiScenario = async (context) => {
  const { bot, log, signal } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const destination = new Vec3(...params.destination);
  const barriers = params.barriers.map((position) => new Vec3(...position));
  const runtime = await openRuntime(context, context.scenario.name ?? "ocean-air-transition");
  const events: Record<string, number> = {};
  const start = bot.entity.position.clone();
  let minimumAir: number | null = null;
  let minimumHealth = bot.health;
  let wetEyeTicks = 0;
  let ticks = 0;
  let noPathFound = false;
  let barriersIntact = true;
  const eyeBlock = () => bot.blockAt(bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0))?.name ?? null;
  const barrierState = () => barriers.map((position) => ({ position, block: bot.blockAt(position)?.name ?? null }));
  const observe = () => {
    const air = airSupplyTicks(bot);
    if (air !== null) minimumAir = Math.min(minimumAir ?? air, air);
    minimumHealth = Math.min(minimumHealth, bot.health);
    barriersIntact &&= barriers.every((position) => bot.blockAt(position)?.name === "dirt");
    if (eyeBlock() === "water") wetEyeTicks++;
    if (++ticks % 40 === 0) log(JSON.stringify({ position: bot.entity.position, eyeBlock: eyeBlock(), air,
      health: bot.health, owner: runtime.status().survival.owner.current, events }));
  };
  const unsubscribe = runtime.navigation.onEvent((event) => {
    events[event.kind] = (events[event.kind] ?? 0) + 1;
    if (event.kind === "search_finished") noPathFound = event.result === "no_path";
    if (event.kind === "search_started") events[event.reason] = (events[event.reason] ?? 0) + 1;
    if (event.kind === "route_committed") {
      log(JSON.stringify({ route: event.plan.steps.map(({ kind, from, to, operations }) => ({ kind, from, to,
        operations: operations.map(({ kind }) => kind) })) }));
    } else if (event.kind === "search_finished" || event.kind === "calculation_failed" ||
      event.kind === "step_failed" || event.kind === "run_settled" || event.kind === "dive") log(JSON.stringify(event));
  });
  bot.on("physicsTick", observe);
  try {
    // Read-only diagnosis of the exact production policy; the action below uses its defaults.
    const policy = createMovements(bot);
    const barrierPolicies = barriers.map((position) => ({ position,
      block: bot.blockAt(position)?.name ?? null,
      decision: policy.evaluateBreak(context.navigation.world.blockAt(position.x, position.y, position.z),
        position, context.navigation.world).decision }));
    log(JSON.stringify({ start, destination, barriers: barrierPolicies }));
    if (barriers.some((position) => bot.blockAt(position)?.name !== "dirt"))
      return { status: "failed", detail: "Fixture dirt barrier was not loaded and intact before navigation." };
    if (!barrierPolicies.every(({ decision }) => decision.kind === "prohibited" && decision.cause === "opens_into_liquid"))
      return { status: "failed", detail: "Default navigation no longer prohibits every fixture barrier for opening into liquid." };
    const action = runtime.actions.find((action) => action.name === "navigate")!;
    // Digging and scaffolding are enabled by default. No flow-policy override or collection escape hatch.
    const deadline = AbortSignal.timeout(REQUEST_LIMIT_MS);
    const startedAt = performance.now();
    const output = await runtime.run(action, { x: destination.x, y: destination.y, z: destination.z, range: 0.1 },
      AbortSignal.any([signal, deadline]));
    const elapsedMs = Math.round(performance.now() - startedAt);
    const timedOut = deadline.aborted;
    log(JSON.stringify({ navigationOutput: output }));
    const atArrival = bot.entity.position.clone();
    const arrived = atArrival.floored().equals(destination);
    // Observe the real idle/survival handoff, water updates, and replenishment after the request settles.
    let dryTicks = 0;
    for (let tick = 0; tick < 120; tick++) {
      await waitForPhysicsTicks(bot, 1, signal);
      dryTicks = eyeBlock() === "air" ? dryTicks + 1 : 0;
      if (dryTicks >= 20 && (airSupplyTicks(bot) === 300 || airSupplyTicks(bot) === null)) break;
    }
    const air = airSupplyTicks(bot);
    const checks = {
      noPath: output.result.status === "failed" && noPathFound,
      prompt: !timedOut && elapsedMs < REQUEST_LIMIT_MS,
      noCommittedRoute: !events.route_committed,
      destinationNotReached: !arrived && !bot.entity.position.floored().equals(destination),
      barriersIntact: barriersIntact && barriers.every((position) => bot.blockAt(position)?.name === "dirt"),
      // A never-submerged player may not have received any air metadata from the server.
      breathingRecovered: dryTicks >= 20 && (air === 300 || (air === null && wetEyeTicks === 0)),
      unhurt: minimumHealth === 20 && bot.health === 20,
    };
    const evidence = { expectation: "safe_no_path", checks, elapsedMs, result: output.result,
      start, destination, atArrival, end: bot.entity.position,
      arrived, wetEyeTicks, dryTicks, eyeBlock: eyeBlock(), air: airSupplyTicks(bot), minimumAir, minimumHealth,
      barriers: barrierState(), events, bodyOwner: runtime.status().survival.owner.current };
    log(JSON.stringify({ transitionEvidence: evidence }));
    const succeeded = Object.values(checks).every(Boolean);
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    return { status: succeeded ? "succeeded" : "failed",
      detail: `${succeeded ? "Expected safe no_path refusal" : `Refusal checks failed: ${failedChecks.join(", ")}`}; ` +
        `navigation=${output.result.status}; elapsed=${elapsedMs} ms; wet-eye ticks=${wetEyeTicks}; dry ticks=${dryTicks}; ` +
        `minimum air=${minimumAir ?? "unobserved"}; minimum health=${minimumHealth}; ` +
        `intact dirt=${barrierState().filter(({ block }) => block === "dirt").length}/${barriers.length}.` };
  } finally {
    bot.off("physicsTick", observe);
    unsubscribe();
    await runtime.close();
  }
};
