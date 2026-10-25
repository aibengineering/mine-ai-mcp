import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const idleSchema = z.strictObject({
  waitTicks: ticksSchema.optional(),
  players: z.record(z.string(), z.strictObject({ waitTicks: ticksSchema })).optional(),
});

/**
 * Request nothing: the runtime's reflexes own the body while the arranged
 * hazard plays out. World goals carry the verdict; this only keeps the session
 * open for `waitTicks`, or this player's own `players.<username>.waitTicks`.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { waitTicks, players = {} } = idleSchema.parse(context.scenario.params);
  const declared = new Set(context.scenario.players.map(({ name }) => name));
  const unknown = Object.keys(players).filter((name) => !declared.has(name));
  if (unknown.length > 0) throw new Error(`params.players names undeclared players: ${unknown.join(", ")}.`);
  const ticks = players[context.username]?.waitTicks ?? waitTicks;
  if (ticks === undefined) {
    throw new Error(`Idle needs params.waitTicks or params.players.${context.username}.waitTicks.`);
  }
  await context.waitForTicks(ticks);
  return { status: "succeeded", detail: `idled ${ticks} ticks` };
}
