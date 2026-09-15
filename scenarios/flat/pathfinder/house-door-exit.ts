import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { run as navigate } from "./pathfinder-runner.ts";

export const run: MineAiScenario = async (context) => {
  const result = await navigate(context);
  if (result.status !== "succeeded") return result;
  const states = [-60, -59].map((y) => context.bot.blockAt(new Vec3(0, y, 3))?.getProperties());
  return {
    status: states.every((state) => state?.open === false) ? "succeeded" : "failed",
    detail: `${result.detail}; door after passage: ${JSON.stringify(states)}`,
  };
};
