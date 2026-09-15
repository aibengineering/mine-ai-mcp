import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { declaredEntitiesArranged, openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

type Resources = {
  arrowsFired: number; arrowsRecovered: number; shieldBlocks: number; foodEaten: number; scaffoldPlaced: number;
  durabilityUsed: Array<{ slot: number; item: string; before: number; now: number }>;
  weaponChanges: Array<{ from: string | null; to: string | null; reason: string }>;
};
const zero = (): Resources => ({ arrowsFired: 0, arrowsRecovered: 0, shieldBlocks: 0, foodEaten: 0,
  scaffoldPlaced: 0, durabilityUsed: [], weaponChanges: [] });

/** One ordinary navigation request; native hostiles own any combat response. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await wearArmor(context);
  await declaredEntitiesArranged(context);
  const runtime = await openRuntime(context, "navigation-combat-resource-progress");
  const arrow = bot.registry.itemsByName.arrow.id;
  const arrowsBefore = bot.inventory.count(arrow, null);
  let nativeShieldBlocks = 0;
  let nativeArrowsRecovered = 0;
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) nativeShieldBlocks++;
  };
  const collect = (collector: typeof bot.entity, collected: typeof bot.entity) => {
    if (collector.id !== bot.entity.id) return;
    if (collected.name === "arrow") nativeArrowsRecovered++;
    else if (collected.name === "item") {
      try {
        const stack = collected.getDroppedItem();
        if (stack?.name === "arrow") nativeArrowsRecovered += stack.count;
      } catch { /* The runtime also refuses to infer a despawned stack. */ }
    }
  };
  bot._client.on("entity_status", status);
  bot.on("playerCollect", collect);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === NAVIGATE)!;
    const accepted = runtime.asyncActions.submit(action, { x: 30, y: -60, z: 0, range: 1 },
      { submission_id: "physical-combat-resource-progress" }, 1);
    if (accepted.state !== "accepted") return { status: "failed", detail: JSON.stringify(accepted) };
    const reportedWaits: Resources[] = [];
    const snapshots: Resources[] = [];
    let final: Awaited<ReturnType<typeof runtime.asyncActions.wait>>;
    for (;;) {
      signal.throwIfAborted();
      final = await runtime.asyncActions.wait(accepted.actionId, 1_000, signal);
      if (final.state === "pending") {
        reportedWaits.push(final.duringWait.combatResources);
        snapshots.push(final.progress.progress.combatResources);
      }
      else break;
    }
    if (final.state !== "settled") return { status: "failed", detail: JSON.stringify(final) };
    const totals = final.output.progress?.combatResources ?? zero();
    snapshots.push(totals);
    // duringWait starts when each wait call begins, so it can truthfully omit
    // activity before the first wait or between calls. Cumulative snapshots
    // form the complete, non-overlapping reconciliation including settlement.
    const intervals = snapshots.map((current, index) => scalarDelta(snapshots[index - 1] ?? zero(), current));
    const arrowsAfter = bot.inventory.count(arrow, null);
    const summed = intervals.reduce((sum, item) => ({
      ...sum,
      arrowsFired: sum.arrowsFired + item.arrowsFired,
      arrowsRecovered: sum.arrowsRecovered + item.arrowsRecovered,
      shieldBlocks: sum.shieldBlocks + item.shieldBlocks,
      foodEaten: sum.foodEaten + item.foodEaten,
      scaffoldPlaced: sum.scaffoldPlaced + item.scaffoldPlaced,
      durabilityUsed: [...sum.durabilityUsed, ...item.durabilityUsed],
      weaponChanges: [...sum.weaponChanges, ...item.weaponChanges],
    }), zero());
    const reached = bot.entity.position.distanceTo(new Vec3(30.5, -60, 0.5)) <= 2;
    const arrowsMatch = totals.arrowsFired === arrowsBefore + nativeArrowsRecovered - arrowsAfter;
    const waitsMatch = ["arrowsFired", "arrowsRecovered", "shieldBlocks", "foodEaten", "scaffoldPlaced"]
      .every((key) => summed[key] === totals[key]);
    const passed = final.output.result.status === "succeeded" && reached && arrowsMatch && waitsMatch &&
      totals.arrowsFired >= 1 && totals.shieldBlocks >= 1 &&
      nativeShieldBlocks === totals.shieldBlocks && nativeArrowsRecovered === totals.arrowsRecovered;
    return { status: passed ? "succeeded" : "failed", detail: JSON.stringify({ reached, arrowsBefore, arrowsAfter,
      nativeShieldBlocks, nativeArrowsRecovered, totals, reportedWaits, intervals, summed,
      settledStatus: final.output.result.status }) };
  } finally {
    bot._client.off("entity_status", status);
    bot.off("playerCollect", collect);
    await runtime.close();
  }
};

function scalarDelta(before: Resources, after: Resources): Resources {
  return {
    arrowsFired: after.arrowsFired - before.arrowsFired,
    arrowsRecovered: after.arrowsRecovered - before.arrowsRecovered,
    shieldBlocks: after.shieldBlocks - before.shieldBlocks,
    foodEaten: after.foodEaten - before.foodEaten,
    scaffoldPlaced: after.scaffoldPlaced - before.scaffoldPlaced,
    durabilityUsed: [],
    weaponChanges: [],
  };
}
