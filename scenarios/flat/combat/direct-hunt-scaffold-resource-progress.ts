import { COLLECT_MOB_DROP } from "@aibengineering/mine-ai-mcp";
import { declaredEntitiesArranged, openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Direct combat ownership must retain confirmed scaffold receipts through settlement. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await declaredEntitiesArranged(context);
  const runtime = await openRuntime(context, "direct-hunt-scaffold-resource-progress");
  let nativePlaced = 0;
  const blockUpdate = (before: { name: string } | null, after: { name: string }) => {
    if (before?.name === "air" && after.name === "cobblestone") nativePlaced++;
  };
  bot.on("blockUpdate", blockUpdate);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === COLLECT_MOB_DROP)!;
    const accepted = runtime.asyncActions.submit(action,
      { mob_name: "zombie", drop_name: "bone", count: 1 },
      { submission_id: "physical-direct-hunt-scaffold-progress" }, 1);
    if (accepted.state !== "accepted") return { status: "failed", detail: JSON.stringify(accepted) };
    const waiterPlaced: number[] = [];
    let final: Awaited<ReturnType<typeof runtime.asyncActions.wait>>;
    for (;;) {
      signal.throwIfAborted();
      final = await runtime.asyncActions.wait(accepted.actionId, 1_000, signal);
      if (final.state === "pending") waiterPlaced.push(final.duringWait.combatResources.scaffoldPlaced);
      else break;
    }
    if (final.state !== "settled") return { status: "failed", detail: JSON.stringify(final) };
    const totalPlaced = final.output.progress?.combatResources.scaffoldPlaced ?? 0;
    const waiterSum = waiterPlaced.reduce((sum, value) => sum + value, 0);
    const gainedBone = bot.inventory.count(bot.registry.itemsByName.bone.id, null);
    const result = final.output.result;
    const bounded = isSafeUnreachable(result);
    const passed = bounded && nativePlaced > 0 && nativePlaced === totalPlaced && waiterSum === totalPlaced;
    return { status: passed ? "succeeded" : "failed", detail: JSON.stringify({ nativePlaced, totalPlaced,
      waiterPlaced, waiterSum, gainedBone, result: final.output.result }) };
  } finally {
    bot.off("blockUpdate", blockUpdate);
    await runtime.close();
  }
};

function isSafeUnreachable(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const value = result as { status?: unknown; termination?: unknown; handoff?: { kind?: unknown; basis?: unknown } };
  return value.status === "failed" && value.termination === "targets_unreachable" &&
    value.handoff?.kind === "safe" && value.handoff.basis === "clear";
}
