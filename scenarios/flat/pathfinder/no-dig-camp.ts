import { Vec3 } from "vec3";
import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  const runner = new ActionRunner();
  const navigate = createNavigateAction(bot, navigation);
  const building: Vec3[] = [];
  for (let x = -2; x <= 2; x++)
    for (let y = -61; y <= -58; y++) for (let z = -2; z <= 2; z++) building.push(new Vec3(x, y, z));
  const details: string[] = [];
  for (const kind of ["door", "sealed"] as const) {
    if (kind === "sealed") {
      // Fixture arrangement: replace the door and return inside the same camp.
      bot.chat("/fill -2 -60 0 -2 -59 0 cobblestone");
      bot.chat(`/tp ${bot.username} 0.5 -60 0.5`);
      await bot.waitForTicks(4);
    }
    if (!(await standStill(context))) return { status: "failed", detail: `${kind}: arrangement did not settle.` };
    const before = building.map((position) => bot.blockAt(position)?.stateId);
    if (before.some((state) => state === undefined)) return { status: "failed", detail: "Camp was not fully loaded." };
    const output = await runner.run(
      navigate,
      { x: 0, y: -60, z: -4, range: 0, dig: false, scaffold: false },
      context.signal,
    );
    const changed = building.filter((position, index) => bot.blockAt(position)?.stateId !== before[index]);
    const released = Object.values(bot.controlState).every((held) => !held);
    const expected = kind === "door" ? "succeeded" : "failed";
    const result = output.result;
    const reason = result.status === "succeeded" ? "none" : result.error;
    details.push(
      `${kind}: ${result.status}, changed cells=${changed.length}, controls released=${released}, error=${reason}`,
    );
    if (
      result.status !== expected ||
      changed.length > 0 ||
      !released ||
      (kind === "sealed" && !reason?.includes("no path"))
    )
      return { status: "failed", detail: details.join("; ") };
  }
  return { status: "succeeded", detail: details.join("; ") };
};
