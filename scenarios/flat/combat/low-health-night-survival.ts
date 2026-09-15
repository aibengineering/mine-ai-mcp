/** Judge survival under real pressure; the production runtime chooses its response. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { hurt } from "./reflex.ts";

const paramsSchema = z.strictObject({ startingHealth: z.number().int().min(1).max(20) });

/** A death ends the attempt immediately, even if Mineflayer subsequently respawns. */
function observeSurvival(context: MineAiScenarioContext, seconds: number): Promise<"survived" | "died" | "cancelled"> {
  const { bot, signal } = context;
  if (signal.aborted) return Promise.resolve("cancelled");
  if (bot.health <= 0) return Promise.resolve("died");
  return new Promise((resolve) => {
    const finish = (outcome: "survived" | "died" | "cancelled") => {
      clearTimeout(timer);
      bot.off("death", onDeath);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onDeath = () => finish("died");
    const onAbort = () => finish("cancelled");
    const timer = setTimeout(() => finish(bot.health > 0 ? "survived" : "died"), seconds * 1000);
    bot.once("death", onDeath);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { startingHealth } = paramsSchema.parse(context.scenario.params);
  const goal = context.scenario.goal;
  const survival = goal.kind === "all" ? goal.goals.find((child) => child.kind === "survive") : undefined;
  if (!survival || survival.kind !== "survive") throw new Error("This driver requires a declared survive goal");

  // The host has already observed the player's position and inventory. Mobs
  // activate at start, so wait only for their spawn packets before judging setup.
  const expected = new Map<string, number>();
  for (const entity of context.scenario.entities) {
    const type = entity.type.replace(/^minecraft:/, "");
    expected.set(type, (expected.get(type) ?? 0) + 1);
  }
  const threats = [...expected].map(([type, count]) => `${count} ${type}`).join(", ");
  for (let ticks = 0; ticks < 40; ticks++) {
    context.signal.throwIfAborted();
    const nearby = Object.values(bot.entities).filter((entity) => entity.position.distanceTo(bot.entity.position) < 16);
    if ([...expected].every(([type, count]) => nearby.filter((entity) => entity.name === type).length === count)) break;
    if (ticks === 39) return { status: "failed", detail: `Setup failed: the declared threats were not observed (${threats})` };
    await bot.waitForTicks(1);
  }
  if (!(await hurt(context, startingHealth)) || bot.health <= 0) {
    return { status: "failed", detail: `Setup failed: could not establish ${startingHealth} health; observed ${bot.health}` };
  }

  const runtime = await openRuntime(context, "low-health-night-survival");
  try {
    context.log(`Survival window started: ${survival.seconds}s, health ${bot.health}, ${threats}; any strategy allowed`);
    const outcome = await observeSurvival(context, survival.seconds);
    return {
      status: outcome === "survived" ? "succeeded" : "failed",
      detail: `${outcome}; ${survival.seconds}s survival window; final health ${bot.health}`,
    };
  } finally {
    await runtime.close();
  }
}
