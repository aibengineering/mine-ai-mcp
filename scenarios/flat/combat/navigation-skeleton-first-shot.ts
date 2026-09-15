import { NAVIGATE, navigateResultSchema } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { z } from "zod";
import { isWindingUp } from "../../../src/survival/perception/combat/observations.ts";
import { bowDrawAimedAtBot } from "../../../src/survival/perception/combat/attention.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { readEncounters } from "./reflex.ts";

/** One ordinary journey; record first-shot timing without priming a fight or faking damage. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const [x, y, zCoordinate] = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .parse(context.scenario.params?.destination ?? [44, -60, 0]);
  const runtime = await openRuntime(context, "navigation-skeleton-first-shot");
  const healthBefore = bot.health;
  let minimumHealth = healthBefore;
  let tick = 0;
  const first: Record<string, unknown> = {};
  const draws = new Map<number, unknown>();
  let shots = 0;
  const damaged = new AbortController();
  let firstDamageCapture: Promise<void> | undefined;
  const health = () => {
    if (bot.health < minimumHealth)
      context.log(JSON.stringify({ event: "damage", tick, health: bot.health, first, draws: [...draws], shots, owner: runtime.status().owner }));
    minimumHealth = Math.min(minimumHealth, bot.health);
    if (minimumHealth < healthBefore && !firstDamageCapture)
      firstDamageCapture = runtime.captureIncident().then(
        (capture) => { context.log(JSON.stringify({ event: "first_damage_capture", capture })); },
        (error) => { context.log(JSON.stringify({ event: "first_damage_capture_failed", error: String(error) })); },
      );
    if (minimumHealth < 20) damaged.abort(new Error("Navigation took damage; preserve the first-shot evidence."));
  };
  const observe = () => {
    tick++;
    minimumHealth = Math.min(minimumHealth, bot.health);
    const drawing = Object.values(bot.entities).find((entity) => entity.name === "skeleton" && isWindingUp(bot, entity));
    if (drawing && first.draw === undefined)
      first.draw = { tick, distance: drawing.position.distanceTo(bot.entity.position), owner: runtime.status().owner };
    for (const entity of Object.values(bot.entities)) {
      if (entity.name === "skeleton" && !draws.has(entity.id) && bowDrawAimedAtBot(bot, entity))
        draws.set(entity.id, { tick, distance: entity.position.distanceTo(bot.entity.position), position: entity.position.clone(), owner: runtime.status().owner });
    }
    if (bot.usingHeldItem && first.shield === undefined) first.shield = tick;
  };
  const hurt = (entity: typeof bot.entity) => {
    if (entity.id === bot.entity.id && first.hurt === undefined) first.hurt = tick;
  };
  const spawned = (entity: typeof bot.entity) => {
    if (entity.name === "arrow") {
      shots++;
      if (first.arrow === undefined) first.arrow = tick;
    }
  };
  bot.on("physicsTick", observe);
  bot.on("entityHurt", hurt);
  bot.on("entitySpawn", spawned);
  bot.on("health", health);
  try {
    const navigate = runtime.actions.find((action) => action.name === NAVIGATE)!;
    const output = await runtime.run(navigate, { x, y, z: zCoordinate, range: 1, dig: false, scaffold: false }, AbortSignal.any([signal, damaged.signal]));
    minimumHealth = Math.min(minimumHealth, bot.health);
    const result = "kind" in output.result ? null : navigateResultSchema.parse(output.result);
    const arrived = result?.status === "succeeded" && bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zCoordinate + 0.5)) < 3;
    const evidence = { first, draws: [...draws], shots, healthBefore, minimumHealth, result: output.result, encounters: await readEncounters(context, runtime) };
    context.log(JSON.stringify(evidence));
    return {
      status: arrived && minimumHealth === 20 ? "succeeded" : "failed",
      detail: `Arrival ${arrived}; minimum health ${minimumHealth}; arrows ${shots}; aimed bow holders ${draws.size}; first events ${JSON.stringify(first)}. Full evidence in client log.`,
    };
  } finally {
    bot.off("physicsTick", observe);
    bot.off("entityHurt", hurt);
    bot.off("entitySpawn", spawned);
    bot.off("health", health);
    context.log(JSON.stringify({ event: "navigation_guard_summary", first, draws: [...draws], shots, minimumHealth }));
    await firstDamageCapture;
    await runtime.close();
  }
};
