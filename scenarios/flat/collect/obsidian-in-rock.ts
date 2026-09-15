/**
 * `collect_block obsidian` against a lava pool sealed in rock, with a
 * running census of the pool.
 *
 * The plain collector driver reports the action's own words, which for this
 * fixture said only that nothing arrived. What the pool did — whether water
 * ever landed, whether any lava turned, and when the bucket emptied — is the
 * evidence that says which step failed, so this driver samples it every second
 * and prints it beside the result.
 */
import {
  attachHighlighter,
  createCollectBlockAction,
  ActionRunner,
} from "@aibengineering/mine-ai-mcp";
import type { Bot } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  block_name: z.string(),
  count: z.number().int().positive(),
  scaffold: z.boolean().optional(),
  /** The corner-to-corner box the census counts, which is the pool and the rock around it. */
  census: z.strictObject({
    from: z.tuple([z.number(), z.number(), z.number()]),
    to: z.tuple([z.number(), z.number(), z.number()]),
  }),
});

const SAMPLE_MS = 1_000;

function census(bot: Bot, from: Vec3, to: Vec3): string {
  const counts = new Map<string, number>();
  for (let x = from.x; x <= to.x; x += 1) {
    for (let y = from.y; y <= to.y; y += 1) {
      for (let z = from.z; z <= to.z; z += 1) {
        const name = bot.blockAt(new Vec3(x, y, z))?.name ?? "unloaded";
        if (name === "stone" || name === "air" || name === "cave_air") continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}

function carried(bot: Bot): string {
  return bot.inventory
    .items()
    .map((item) => `${item.name}x${item.count}`)
    .join(",");
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const from = new Vec3(...params.census.from);
  const to = new Vec3(...params.census.to);
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });

  let last = "";
  const sample = () => {
    const feet = bot.entity.position.floored();
    const line = `pool[${census(bot, from, to)}] hand[${bot.heldItem?.name ?? "empty"}] inv[${carried(bot)}]`;
    if (line === last) return;
    last = line;
    context.log(`${feet.x},${feet.y},${feet.z} ${line}`);
  };
  sample();
  const ticker = setInterval(sample, SAMPLE_MS);

  try {
    const { block_name, count, scaffold } = params;
    const { result, durationMs } = await runner.run(
      createCollectBlockAction(bot, context.navigation),
      { block_name, count, ...(scaffold !== undefined && { scaffold }) },
      context.signal,
    );
    sample();
    const error = "error" in result ? result.error : "";
    context.log(`${result.status} (${durationMs} ms)${error ? ` — ${error}` : ""}`);
    return {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      detail: `${result.status} in ${durationMs} ms; ${last}${error ? `; ${error}` : ""}`,
    };
  } finally {
    clearInterval(ticker);
  }
}
