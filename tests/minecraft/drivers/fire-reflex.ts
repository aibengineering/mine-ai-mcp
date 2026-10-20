import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { run as runSequence } from "./action-sequence.ts";

const holdSchema = z.object({ holdTicks: ticksSchema.optional() });

/**
 * `action-sequence.ts`, plus an optional `holdTicks` per pen: the session stays
 * open that long after the last step, so the runtime's reflexes keep the body
 * while an arranged hazard that outlives the request (a zombie still in the
 * pen, a residual burn) plays out. The host closes the runtime, and every
 * reflex with it, as soon as the driver returns.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = context.scenario.params;
  const players = z.record(z.string(), z.unknown()).parse(params.players ?? {});
  const envelope = players[context.username];
  const { holdTicks } = holdSchema.parse(envelope ?? {});
  const withoutHold = Object.fromEntries(
    Object.entries(players).map(([name, pen]) => {
      if (typeof pen !== "object" || pen === null) return [name, pen];
      const { holdTicks: _hold, ...request } = pen as Record<string, unknown>;
      return [name, request];
    }),
  );
  const scenario = { ...context.scenario, params: { ...params, players: withoutHold } };
  const completion = await runSequence({ ...context, scenario });
  if (completion.status !== "succeeded" || holdTicks === undefined) return completion;
  await context.waitForTicks(holdTicks);
  return { ...completion, detail: `${completion.detail}; held ${holdTicks} ticks` };
}
