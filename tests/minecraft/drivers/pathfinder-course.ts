/**
 * A route of named navigation legs, each verified before the next starts.
 *
 * Every leg is observed with `view_status` after it settles (ten ticks by
 * default, so a final landing can finish): a successful navigate leg must be
 * standing within its range of the marker, and every leg, refused or not, must
 * leave the bot alive at full health. Digging and scaffolding default to off,
 * course-wide or per leg; a leg may also build, omit y, expect a refusal, wait
 * out a hazard with reflexes live, or run another action. Mine Labs checks the
 * final position, health, deaths and protected blocks independently.
 */
import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const observedLeg = {
  label: z.string().min(1),
  /**
   * Ticks to wait before observing the result. The runtime, and its reflexes,
   * stay live meanwhile, so a hazard still advancing when the action settles is
   * observed once it has run its course.
   */
  settleTicks: ticksSchema.default(10),
  expect: expectationSchema,
  /**
   * A survival reflex may take the body over and cancel this leg, provided the
   * recorded reason contains this text, such as "[BREATH]". Any other runtime
   * failure or cancellation still fails the leg.
   */
  takeover: z.string().min(1).optional(),
};

const navigateLegSchema = z.strictObject({
  ...observedLeg,
  /** `[x, z]` omits y, asking navigate for the ground column at x,z. */
  target: z.union([z.tuple([z.number(), z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
  range: z.number().nonnegative(),
  dig: z.boolean().optional(),
  scaffold: z.boolean().optional(),
  build: z.boolean().optional(),
  /**
   * How far beyond its range the settled body may be from the marker. The
   * default allows the half-cell diagonal and fractional footing; a swim that
   * ends mid-column keeps rising after it reports arrival.
   */
  tolerance: z.number().nonnegative().default(0.75),
});

/** Another action on the course, such as a collection, observed the same way. */
const actionLegSchema = z.strictObject({
  ...observedLeg,
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
});

const courseSchema = z.strictObject({
  /** Course-wide navigate defaults; a leg may override either. */
  dig: z.boolean().default(false),
  scaffold: z.boolean().default(false),
  /** Let an arranged hazard settle before the first leg. */
  waitTicks: ticksSchema.optional(),
  legs: z.array(z.union([navigateLegSchema, actionLegSchema])).min(1),
});

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const course = playerParams(context, courseSchema);
  if (course.waitTicks !== undefined) await context.waitForTicks(course.waitTicks);
  const completed: string[] = [];
  const fail = (detail: string): ClientCompletion => ({ status: "failed", detail: [...completed, detail].join("; ") });

  for (const leg of course.legs) {
    let marker: { x: number; y: number; z: number; reach: number } | undefined;
    let output;
    if ("action" in leg) {
      output = await context.call(leg.action, leg.input);
    } else {
      const [x, y, z] = leg.target.length === 3 ? leg.target : [leg.target[0], undefined, leg.target[1]];
      if (y !== undefined) marker = { x, y, z, reach: leg.range + leg.tolerance };
      output = await context.call("navigate", {
        x,
        ...(y === undefined ? {} : { y }),
        z,
        range: leg.range,
        dig: leg.dig ?? course.dig,
        scaffold: leg.scaffold ?? course.scaffold,
        ...(leg.build === undefined ? {} : { build: leg.build }),
      });
    }
    const expected = checkExpectation(leg.expect, output);
    const takenOver =
      leg.takeover !== undefined &&
      // A reflex that takes the leg and hands it back reports it failed with
      // the reflex's reason; the named takeover is what the leg accepts.
      (("kind" in output.result && output.result.kind === "runtime_failure") || output.result.status === "failed" || output.result.status === "cancelled") &&
      output.summary.includes(leg.takeover);
    const detail = takenOver ? output.summary : expected.detail;
    if (!expected.matches && !takenOver) return fail(`${leg.label}: ${detail}`);

    // A route can enter its accepted feet cell while the last drop is still
    // settling, and a refusal can still have moved the body. Observe both once
    // the leg has settled, including any damage.
    await context.waitForTicks(leg.settleTicks);
    const status = await context.call("view_status", {});
    const observed = viewStatusResultSchema.parse(status.result);
    if (observed.status !== "succeeded") return fail(`${leg.label}: ${status.summary}`);
    const { position, vitals, lastDeath } = observed.situation;
    const where = `at ${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`;
    // A body that died and respawned is back at full health.
    if (lastDeath !== null) return fail(`${leg.label}: died (${lastDeath.cause ?? "unknown cause"}) after ${detail}`);
    if (vitals.health < 20) return fail(`${leg.label}: health ${vitals.health} ${where} after ${detail}`);
    if (output.result.status === "succeeded" && marker) {
      // Navigate ranges use integer feet cells; compare the entity position
      // with the marker's centre.
      const distance = Math.hypot(position.x - (marker.x + 0.5), position.y - marker.y, position.z - (marker.z + 0.5));
      if (distance > marker.reach) {
        return fail(`${leg.label}: observed arrival ${distance.toFixed(2)} blocks from marker ${where} after ${detail}`);
      }
    }
    completed.push(`${leg.label}: ${detail}`);
  }
  return { status: "succeeded", detail: completed.join("; ") };
}
