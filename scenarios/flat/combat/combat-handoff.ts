/** Reach the requested destinations alive through the production survival runtime. */
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, excessExplosions, readEncounters, watchExplosions, watchShield } from "./reflex.ts";

const destination = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const paramsSchema = z.strictObject({
  wearArmor: z.boolean().default(false),
  firstTarget: destination,
  secondTarget: destination.optional(),
  forbidHide: z.boolean().default(false),
  requireEncounter: z.boolean().default(false),
  maxExplosions: z.number().int().nonnegative().optional(),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-navigation");
  const explosions = watchExplosions(context);
  const shield = watchShield(context);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const death = () => died.abort("bot died");
  context.bot.on("death", death);
  try {
    if (params.wearArmor) await wearArmor(context);
    if (params.forbidHide) {
      await runtime.run(
        runtime.actions.find((action) => action.name === "set_survival_policy")!,
        {
          operation: "set",
          expected_revision: runtime.status().survivalPolicy.revision,
          changes: { combat: { hide: "never" } },
          lifetime: { kind: "session" },
          reason: "Scenario setup.",
        },
        signal,
      );
    }
    const navigate = runtime.actions.find((action) => action.name === NAVIGATE)!;
    for (const [x, y, zPosition] of [params.firstTarget, ...(params.secondTarget ? [params.secondTarget] : [])]) {
      const output = await runtime.run(navigate, { x, y, z: zPosition, range: 1 }, signal);
      context.log(`NAVIGATION ${JSON.stringify(output)}`);
      if (context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zPosition + 0.5)) > 2)
        return { status: "failed", detail: `Did not reach ${x},${y},${zPosition}: ${JSON.stringify(output)}` };
    }
    const encounters = await readEncounters(context, runtime);
    const exploded = excessExplosions(explosions.count(), params.maxExplosions);
    const unexpectedHide = params.forbidHide && encounters.some((encounter) => encounter.response === "hide");
    const missedEncounter = params.requireEncounter && encounters.length === 0;
    return {
      status:
        !died.signal.aborted && context.bot.health > 0 && !exploded && !unexpectedHide && !missedEncounter
          ? "succeeded"
          : "failed",
      detail: `${exploded ?? ""}${unexpectedHide ? "Unexpected hide response; this route must manage the creepers without shelter." : ""}${missedEncounter ? "The route completed without exercising a hostile response." : ""}; ${encounters.map(describe).join(" | ")}; ${shield.summary()}`,
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: "Bot died before completing the route." };
  } finally {
    context.bot.off("death", death);
    shield.close();
    explosions.close();
    await runtime.close();
  }
}
