import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const routeSchema = z.strictObject({
  dig: z.boolean().default(false),
  legs: z.array(z.strictObject({
    target: z.tuple([z.number(), z.number(), z.number()]),
    range: z.number().nonnegative(),
    label: z.string(),
  })).min(1),
});

/** Verify each named arrival before continuing; only excavation courses permit digging. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { legs, dig } = routeSchema.parse(context.scenario.params);
  const completed: string[] = [];
  for (const { target: [x, y, z], range, label } of legs) {
    const output = await context.call("navigate", { x, y, z, range, dig, scaffold: false });
    completed.push(`${label}: ${output.summary}`);
    if (output.result.status !== "succeeded") {
      return { status: "failed", detail: completed.join("; ") };
    }
    // A route can enter its accepted feet cell while the last drop is still
    // settling. Observe the arrival after that landing, including any damage.
    await context.waitForTicks(10);
    const status = await context.call("view_status", {});
    const observed = viewStatusResultSchema.parse(status.result);
    if (observed.status !== "succeeded") return { status: "failed", detail: `${label}: ${status.summary}` };
    const position = observed.situation.position;
    // Navigate ranges use integer feet cells. Allow the horizontal half-cell
    // diagonal and fractional footing when comparing the actual entity position.
    const distance = Math.hypot(position.x - (x + 0.5), position.y - y, position.z - (z + 0.5));
    if (distance > range + 0.75 || observed.situation.vitals.health < 20) {
      return { status: "failed", detail: `${label}: observed arrival ${distance.toFixed(2)} blocks from marker, health ${observed.situation.vitals.health}; ${completed.join("; ")}` };
    }
  }
  return { status: "succeeded", detail: completed.join("; ") };
}
