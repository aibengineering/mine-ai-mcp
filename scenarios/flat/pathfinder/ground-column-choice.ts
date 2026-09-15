import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  if (!(await standStill(context))) return { status: "failed", detail: "Player did not settle." };
  await using runtime = await openRuntime(context, "ground-column-choice");
  const navigate = runtime.actions.find((action) => action.name === "navigate");
  if (!navigate) throw new Error("Navigation action missing");
  const start = context.bot.entity.position.clone();
  for (const x of [4, 8, 12]) {
    const output = await runtime.run(navigate, { x, z: 0, scaffold: false }, context.signal);
    if (output.result.status !== "failed" || !output.result.error?.includes("NAVIGATION_HEIGHT_REQUIRED"))
      return { status: "failed", detail: `Roof at x=${x} was not refused: ${JSON.stringify(output.result)}` };
    if (context.bot.entity.position.distanceTo(start) > 0.1)
      return { status: "failed", detail: "An ambiguous ground request moved the player." };
  }
  const output = await runtime.run(navigate, { x: 12, y: -60, z: 0, range: 0, scaffold: false }, context.signal);
  const feet = context.bot.entity.position.floored();
  const arrived = feet.x === 12 && feet.y === -60 && feet.z === 0 && context.bot.entity.onGround;
  return {
    status: output.result.status === "succeeded" && arrived ? "succeeded" : "failed",
    detail: `Three ambiguous columns refused; explicit floor arrival ${arrived}; health ${context.bot.health}.`,
  };
};
