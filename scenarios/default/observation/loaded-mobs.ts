/**
 * Hold `view_status`'s loaded-mob summary to its published contract on a
 * generated world, where the mobs are whatever the seed spawned.
 *
 * A flat fixture can only contain the species it was told to summon, so it
 * proves the grouping and nothing about the registry. Every entity type
 * minecraft-data files under a mob category has to survive the published
 * schema, and only a generated world with mob spawning on presents them
 * unchosen. The contract publishes six kinds because the registry's five named
 * types leave slimes, ghasts, phantoms, shulkers, and iron golems as plain
 * `mob`; if a seeded world loads a species with a type outside those six, the
 * summary drops it silently and this scenario is what says so.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  MOB_KINDS,
  ActionRunner,
  SqlBotData,
  createViewStatusAction,
  formatViewStatusResult,
  viewStatusResultSchema,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /** How long to let entities arrive after the chunks do. */
  settle_ms: z.number().int().positive(),
});

/** minecraft-data's mob categories, as Mineflayer republishes them on `entity.kind`. */
const MOB_CATEGORIES = new Set(["Passive mobs", "Hostile mobs"]);

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const seed = String(context.scenario.world.seed ?? "unseeded");
  using data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: `loaded-mobs-${seed}`, scope: { kind: "bot", botId: bot.username } },
  });

  await bot.waitForChunksToLoad();
  await new Promise((resolve) => setTimeout(resolve, params.settle_ms));
  context.signal.throwIfAborted();

  const runner = new ActionRunner();
  const action = createViewStatusAction(bot, data, () => {
    const { owner, activeAction } = runner.status();
    return { owner, activeAction };
  });
  const output = await runner.run(action, {}, context.signal);

  // Parsed the way an MCP client parses it: a kind the contract does not
  // publish stops the read here rather than reaching a caller.
  const parsed = viewStatusResultSchema.safeParse(output.result);
  if (!parsed.success) {
    return {
      status: "failed",
      detail: `seed ${seed}: the result failed its published schema, so the contract is wrong, not the fixture: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const result = parsed.data;
  if (result.status !== "succeeded") return { status: "failed", detail: `seed ${seed}: read ${result.status}` };

  const { position } = result.situation;
  const where = `seed ${seed} at ${position.x}, ${position.y}, ${position.z} (on ground: ${position.onGround})`;
  const { mobs } = result.situation.nearby;
  const summary = mobs.map((mob) => `${mob.name}/${mob.kind} x${mob.count} at ${mob.nearest.distance}`).join(", ");
  context.log(`${where}: ${mobs.length} species loaded: ${summary || "none"}`);

  // A species the registry calls a mob but types outside the published six is
  // dropped by the summary without a word, so ask the live registry directly.
  const unknown = new Set<string>();
  for (const entity of Object.values(bot.entities)) {
    const registered = entity?.entityType === undefined ? undefined : bot.registry.entities[entity.entityType];
    if (!registered || !MOB_CATEGORIES.has(registered.category ?? "")) continue;
    if (!MOB_KINDS.includes(registered.type as (typeof MOB_KINDS)[number])) {
      unknown.add(`${registered.name} (${registered.category}/${registered.type})`);
    }
  }

  const markdown = formatViewStatusResult(result);
  const complaints: string[] = [];
  if (unknown.size > 0) {
    complaints.push(`the registry loaded mob types the contract does not publish: ${[...unknown].sort().join(", ")}`);
  }
  if (mobs.length === 0) complaints.push("no mob species were loaded, so the summary proved nothing");
  for (const [index, mob] of mobs.entries()) {
    if (!MOB_KINDS.includes(mob.kind)) complaints.push(`${mob.name} published kind '${mob.kind}'`);
    const previous = mobs[index - 1];
    if (previous && previous.nearest.distance > mob.nearest.distance) {
      complaints.push(
        `${mob.name} at ${mob.nearest.distance} follows ${previous.name} at ${previous.nearest.distance}`,
      );
    }
    const age = mob.age === "not_applicable" ? "" : `, ${mob.age === "unknown" ? "age unknown" : mob.age}`;
    const line = `- ${mob.name} (${mob.kind}${age}) x${mob.count}, nearest #${mob.nearest.entityId} ${mob.nearest.distance} at `;
    if (!markdown.includes(line)) complaints.push(`the Markdown does not list ${mob.name}`);
  }
  if (complaints.length > 0) return { status: "failed", detail: `${where}: ${complaints.join("; ")}` };

  return { status: "succeeded", detail: `${where}: ${mobs.length} species loaded: ${summary}` };
}
