/**
 * Chase and collect every dropped item the fixture summoned.
 *
 * This drives the production pickup path: a coarse near-entity A* route followed
 * by Pathfinder's local steering driver against the live item position.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { createMovements } from "../../../src/navigation/index.ts";
import { pickupObservedItem } from "../../../src/world/item-pickup.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({ expected: z.number() });

/** One item's worth of patience. A stuck chase should not eat the whole run. */
const PICKUP_TIMEOUT_MS = 30_000;

function observedDrops(context: MineAiScenarioContext): number[] {
  return Object.values(context.bot.entities)
    .filter((entity) => entity.name === "item")
    .map((entity) => entity.id);
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const movements = createMovements(bot);

  // The summons run over rcon before this client connects, so a drop that
  // happens to lie within pickup range of the login position is already in the
  // inventory by the time the bot is teleported to its start. That is one
  // fewer entity to chase, not a missing entity, so count it as accounted for
  // rather than reporting a short world.
  const held = () => bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
  const accountedFor = () => observedDrops(context).length + held();
  const deadline = Date.now() + 15_000;
  while (accountedFor() < params.expected && Date.now() < deadline) {
    await bot.waitForTicks(5);
  }
  if (accountedFor() < params.expected) {
    return {
      status: "failed",
      detail:
        `Only ${observedDrops(context).length} drops and ${held()} collected diamonds account for ` +
        `${params.expected} expected. ${context.pathfinder.summary()}`,
    };
  }
  const drops = observedDrops(context);

  const collected: string[] = [];
  for (const entityId of drops) {
    const before = bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
    const result = await pickupObservedItem(bot, {
      entityId,
      movements,
      navigate: context.navigation.navigate,
      hasArrived: () => bot.inventory.count(bot.registry.itemsByName.diamond!.id, null) > before,
      timeoutMs: PICKUP_TIMEOUT_MS,
      signal: context.signal,
    });
    collected.push(`${entityId}:${result.kind}`);
    context.log(`pickup ${entityId} -> ${result.kind}`);
  }

  const total = bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
  const detail = `collected ${total} of ${params.expected} (${collected.join(", ")}); ${context.pathfinder.summary()}`;
  return total >= params.expected ? { status: "succeeded", detail } : { status: "failed", detail };
}
