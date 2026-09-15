/** Observe an idle bot under the declared conditions; YAML owns the world goals. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, excessExplosions, hurt, readEncounters, watchExplosions, watchShield } from "./reflex.ts";

const paramsSchema = z.strictObject({
  provoke: z.string().optional(),
  hurtTo: z.number().int().nonnegative().optional(),
  wearArmor: z.boolean().default(false),
  /** Observation duration, not a deadline for a particular survival response. */
  waitTicks: z.number().int().positive(),
  /** Single-quarry fixtures can finish once its death and the combat handoff are observed. */
  finishAfterTargetDeath: z.string().optional(),
  maxExplosions: z.number().int().nonnegative().optional(),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-idle");
  const explosions = watchExplosions(context);
  const shield = watchShield(context);
  let died = false;
  let targetDied = false;
  const targetDeath = (entity: typeof context.bot.entity) => {
    if (params.finishAfterTargetDeath && entity.name === params.finishAfterTargetDeath) targetDied = true;
  };
  context.bot.on("entityDead", targetDeath);
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    if (params.wearArmor) await wearArmor(context);
    if (params.hurtTo !== undefined && !(await hurt(context, params.hurtTo)))
      return { status: "failed", detail: `Arrangement could not establish ${params.hurtTo} health.` };
    if (params.provoke)
      context.bot.chat(
        `/damage @e[type=minecraft:${params.provoke},limit=1,sort=nearest] 1 minecraft:player_attack by @s`,
      );
    for (let tick = 0; tick < params.waitTicks && !died; tick++) {
      context.signal.throwIfAborted();
      if (targetDied && !runtime.status().busy) break;
      await context.bot.waitForTicks(1);
    }
    const encounters = await readEncounters(context, runtime);
    const exploded = excessExplosions(explosions.count(), params.maxExplosions);
    return {
      status: !died && context.bot.health > 0 && !exploded ? "succeeded" : "failed",
      detail: `${exploded ?? ""}; health ${context.bot.health}; died ${died}; ${encounters.map(describe).join(" | ")}; ${shield.summary()}`,
    };
  } finally {
    context.bot.off("entityDead", targetDeath);
    context.bot.off("death", death);
    shield.close();
    explosions.close();
    await runtime.close();
  }
}
