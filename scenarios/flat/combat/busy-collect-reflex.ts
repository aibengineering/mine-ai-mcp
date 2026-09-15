/**
 * The bot is part-way through a mining job, and a zombie walks up behind it.
 *
 * The fixture asks for the original collection while a zombie supplies real
 * hostile pressure. The independent goals judge the haul and the bot's
 * survival. Encounter records remain diagnostic evidence.
 */
import { COLLECT_BLOCK, collectBlockResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, excessExplosions, readEncounters, watchExplosions, watchShield } from "./reflex.ts";

const paramsSchema = z.strictObject({
  blockName: z.string(),
  /** Enough to still be digging when the zombie arrives. */
  count: z.number().int().positive(),
  /** Explosions the fixture tolerates; a creeper fixture permits none. */
  maxExplosions: z.number().int().nonnegative().optional(),
});

// @function-metrics size=20 branches=7 fan-out=9 depth=3 interface=3 fan-in=0
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-busy-collect");
  const explosions = watchExplosions(context);
  const shield = watchShield(context);
  let died = false;
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    const collectAction = runtime.actions.find((action) => action.name === COLLECT_BLOCK);
    if (!collectAction) throw new Error("The busy-collect scenario could not find its production collect action.");

    const output = await runtime.run(
      collectAction,
      { block_name: params.blockName, count: params.count, scaffold: false },
      context.signal,
    );
    const exploded = excessExplosions(explosions.count(), params.maxExplosions);
    if (exploded || "kind" in output.result) {
      const encounters = await readEncounters(context, runtime);
      const stop = "kind" in output.result ? `stopped: ${output.result.error}` : `returned ${output.result.status}`;
      return {
        status: "failed",
        detail: `${exploded ?? "The collection did not complete."} The collection ${stop}. ${encounters.map(describe).join(" | ")}`,
      };
    }
    const result = collectBlockResultSchema.parse(output.result);
    if (result.status !== "succeeded") {
      return { status: "failed", detail: `The collection did not succeed: ${result.error}` };
    }
    const encounters = await readEncounters(context, runtime);
    return {
      status: !died && context.bot.health > 0 ? "succeeded" : "failed",
      detail: `${encounters.map(describe).join(" | ")}; explosions ${explosions.count()}; ${shield.summary()}; collected ${result.collected.gained}; died ${died}; interruptions ${output.interruptions?.join("; ") ?? "none"}`,
    };
  } finally {
    context.bot.off("death", death);
    shield.close();
    explosions.close();
    await runtime.close();
  }
}
