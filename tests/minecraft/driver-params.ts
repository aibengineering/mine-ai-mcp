/**
 * YAML request shapes shared by the stock drivers: the per-player envelope
 * that lets each pen of a multi-player fixture carry its own request, and the
 * expected result of one action call.
 */
import { z } from "zod";
import type { ScenarioCall, ScenarioContext } from "./scenario.ts";

const expectedStatusSchema = z.enum(["succeeded", "partial", "failed"]);

/**
 * What one call must report. `status` takes one status or a list of them, for
 * outcomes that depend on the world, such as a hunt asked for more than its pen
 * holds. Success is the default.
 */
export const expectationSchema = z.strictObject({
  status: z.union([expectedStatusSchema, z.array(expectedStatusSchema).min(1)])
    .transform((status) => (Array.isArray(status) ? status : [status])),
  errorContains: z.string().min(1).optional(),
  interruptionContains: z.string().min(1).optional(),
}).default({ status: ["succeeded"] });
export type Expectation = z.output<typeof expectationSchema>;

export const ticksSchema = z.number().int().nonnegative();

/**
 * Whether a call met its expectation. Expecting failure must never turn a
 * runtime failure or cancellation into a passing step.
 */
export function checkExpectation(expect: Expectation, output: ScenarioCall): { matches: boolean; detail: string } {
  const { result } = output;
  if (("kind" in result && result.kind === "runtime_failure") || result.status === "cancelled") {
    return { matches: false, detail: output.summary };
  }
  const error = result.status === "succeeded" ? "" : result.error;
  const interruption = expect.interruptionContains;
  const matches = expect.status.includes(result.status) &&
    (expect.errorContains === undefined || error.includes(expect.errorContains)) &&
    (interruption === undefined ||
      output.interruptions?.some((reason) => reason.includes(interruption)) === true);
  const expected = [
    `Expected ${expect.status.join(" or ")}`,
    expect.errorContains && `error containing ${JSON.stringify(expect.errorContains)}`,
    interruption && `interruption containing ${JSON.stringify(interruption)}`,
  ].filter(Boolean).join(" with ");
  return { matches, detail: matches ? output.summary : `${expected}; ${output.summary}` };
}

/**
 * This session's request. A fixture either declares one scenario-level request
 * for its only actor, or `params.players.<username>` for every pen; mixing the
 * two would leave a pen's request ambiguous, so it is rejected, as is an
 * envelope naming a player the fixture does not declare.
 */
export function playerParams<T extends z.ZodType>(context: ScenarioContext, request: T): z.output<T> {
  const params = context.scenario.params;
  if (!("players" in params)) return request.parse(params);

  const shared = Object.keys(params).filter((key) => key !== "players");
  if (shared.length > 0) {
    throw new Error(`params.players cannot be combined with scenario-level ${shared.join(", ")}; move them into each player's envelope.`);
  }
  const players = z.record(z.string(), z.unknown()).parse(params.players);
  const declared = new Set(context.scenario.players.map(({ name }) => name));
  const unknown = Object.keys(players).filter((name) => !declared.has(name));
  if (unknown.length > 0) throw new Error(`params.players names undeclared players: ${unknown.join(", ")}.`);
  if (!(context.username in players)) {
    throw new Error(`params.players declares no request for '${context.username}'.`);
  }
  const parsed = request.safeParse(players[context.username]);
  if (!parsed.success) {
    throw new Error(`params.players.${context.username}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
