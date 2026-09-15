import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Explicit no-terrain-edits contract in a sealed scene; this is not an acquisition success. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("The sealed scene did not settle.");
  const runtime = await openRuntime(context, "enderman-no-terrain-edits");
  let changedBlocks = 0;
  const blockChanges: unknown[] = [];
  let minimumHealth = bot.health;
  const blockChanged: Parameters<typeof bot.on<"blockUpdate">>[1] = (before, after) => {
    if (before && after && before.stateId !== after.stateId) {
      changedBlocks++;
      blockChanges.push({ position: after.position, before: before.name, after: after.name });
    }
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  bot.on("blockUpdate", blockChanged);
  bot.on("physicsTick", tick);
  try {
    await runtime.run(
      runtime.actions.find((action) => action.name === "set_survival_policy")!,
      {
        operation: "set",
        expected_revision: runtime.status().survivalPolicy.revision,
        changes: { combat: { terrain: { dig: false, place: false } } },
        lifetime: { kind: "session" },
        reason: "Scenario setup.",
      },
      signal,
    );
    const output = await runtime.run(
      runtime.actions.find((action) => action.name === "collect_mob_drop")!,
      { mob_name: "enderman", drop_name: "ender_pearl", count: 1 },
      signal,
    );
    return {
      status: output.result.status !== "succeeded" && changedBlocks === 0 && minimumHealth > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ output, changedBlocks, blockChanges, minimumHealth }),
    };
  } finally {
    bot.off("blockUpdate", blockChanged);
    bot.off("physicsTick", tick);
    await runtime.close();
  }
};
