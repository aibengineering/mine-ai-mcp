/** Reach the surface alive from a wounded, foodless start with mid-route hostile contact. */
import { CANCEL_FOREGROUND_ACTION, NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime, standStill, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, hurt, readEncounters } from "./reflex.ts";

const paramsSchema = z.strictObject({
  /** Health to bring the bot down to before the route is asked for; below the hide bar. */
  hurtTo: z.number().int().positive(),
  /** Feet cell on the plateau the withdraw navigate is asked to reach. */
  target: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  /** Where the zombie is put once the route is under way: on its ledge, in sight, out of contact range. */
  zombie: z.tuple([z.number(), z.number(), z.number()]),
});

/** Vanilla regenerates health only from this hunger up; the live bot was at thirteen with nothing to eat. */
const REGENERATION_HUNGER = 18;

function where(context: MineAiScenarioContext): string {
  const feet = context.bot.entity.position;
  return `${feet.x.toFixed(1)},${feet.y.toFixed(1)},${feet.z.toFixed(1)}`;
}

/**
 * Bring hunger under the regeneration bar, the way the live bot's was.
 *
 * There is no command that sets the bar directly; the hunger effect at its
 * highest amplifier drains saturation and then food points in a second or
 * two, and the driver watches the bar rather than trusting the duration.
 */
// @function-metrics size=6 branches=2 fan-out=3 depth=2 interface=1 fan-in=1
async function starve(context: MineAiScenarioContext): Promise<boolean> {
  const { bot } = context;
  bot.chat("/effect give @s minecraft:hunger 2 255");
  for (let waited = 0; waited < 100; waited += 1) {
    context.signal.throwIfAborted();
    if (bot.food < REGENERATION_HUNGER) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

/** Wait for the navigate to own the body and move the bot off its starting cell, so the hostile arrives mid-route. */
// @function-metrics size=6 branches=2 fan-out=4 depth=2 interface=3 fan-in=1
async function awaitRouteUnderWay(context: MineAiScenarioContext, runtime: Runtime, ticks: number): Promise<boolean> {
  const start = context.bot.entity.position.clone();
  for (let waited = 0; waited < ticks; waited += 1) {
    context.signal.throwIfAborted();
    const active = runtime.status().activeAction?.action;
    if (active === NAVIGATE && context.bot.entity.position.distanceTo(start) >= 1) return true;
    await context.bot.waitForTicks(1);
  }
  return false;
}

/** Put the zombie on its ledge and wait until the client has seen it there. */
// @function-metrics size=7 branches=2 fan-out=5 depth=2 interface=2 fan-in=1
async function placeZombie(context: MineAiScenarioContext, at: readonly [number, number, number]): Promise<boolean> {
  const { bot } = context;
  bot.chat(`/summon minecraft:zombie ${at[0]} ${at[1]} ${at[2]} {PersistenceRequired:1b,NoAI:1b}`);
  for (let waited = 0; waited < 40; waited += 1) {
    context.signal.throwIfAborted();
    const seen = Object.values(bot.entities).some(
      (entity) => entity.name === "zombie" && entity.position.distanceTo(bot.entity.position) <= 16,
    );
    if (seen) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { bot } = context;
  const runtime = await openRuntime(context, "combat-wounded-cave-ascent");
  try {
    if (!(await standStill(context))) {
      return { status: "failed", detail: `The bot never came to rest with vitals known; at ${where(context)}` };
    }
    // Hurt while nothing is watching: the hide bar is what the fixture is
    // about, and a hide before the route starts would only add ninety seconds.
    if (!(await hurt(context, params.hurtTo))) {
      return {
        status: "failed",
        detail: `The bot could not be brought to ${params.hurtTo} health; it is at ${bot.health}`,
      };
    }
    if (!(await starve(context))) {
      return { status: "failed", detail: `Hunger never fell below ${REGENERATION_HUNGER}; it is at ${bot.food}` };
    }
    context.log(`bot at ${bot.health} health and ${bot.food} hunger with nothing to eat`);

    const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
    const cancel = runtime.actions.find((action) => action.name === CANCEL_FOREGROUND_ACTION);
    if (!navigate || !cancel) throw new Error("The ascent scenario requires the navigate and cancel actions.");
    const [x, y, z] = params.target;
    const request = { x, y, z, range: 1, dig: true, scaffold: true };

    const pending = runtime.run(navigate, request, context.signal);
    if (!(await awaitRouteUnderWay(context, runtime, 200))) {
      await runtime.run(cancel, { reason: "The route never got under way." }, context.signal);
      const output = await pending;
      return {
        status: "failed",
        detail: `The withdraw navigate never moved the bot: ${JSON.stringify(output.result)}`,
      };
    }
    if (!(await placeZombie(context, params.zombie))) {
      await runtime.run(cancel, { reason: "The zombie never arrived on its ledge." }, context.signal);
      await pending;
      return { status: "failed", detail: `No zombie was seen within sight of ${params.zombie.join(",")}` };
    }
    context.log(`zombie on its ledge; bot at ${where(context)} with ${bot.health} health`);

    const output = await pending;
    const encounters = await readEncounters(context, runtime);
    const remaining = Math.hypot(
      bot.entity.position.x - (x + 0.5),
      bot.entity.position.y - y,
      bot.entity.position.z - (z + 0.5),
    );
    const evidence = {
      health: bot.health,
      hunger: bot.food,
      position: where(context),
      remaining,
      encounters: encounters.map(describe),
      output,
    };
    return {
      status: bot.health > 0 && remaining <= 2 ? "succeeded" : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    await runtime.close();
  }
}
