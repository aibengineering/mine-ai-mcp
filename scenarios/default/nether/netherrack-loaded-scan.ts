import { Vec3 } from "vec3";
import { findLoadedBlockPositions } from "../../../src/world/loaded-block-scan.ts";
import { declaredStart, openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { observe } from "./hazards/pit.ts";

// The live incident had 1.6–8 second physics gaps. One second already withholds
// twenty normal physics ticks; this regression must fail even if inventory
// eventually succeeds. It is a fixture verdict, not an action timeout.
const MAX_PHYSICS_GAP_MS = 1_000;

export const run: MineAiScenario = async (context) => {
  const { bot, log, signal } = context;
  const dimension = bot.game.dimension;
  const start = declaredStart(context);
  await bot.waitForChunksToLoad();
  // The scenario file builds the same bank in whichever dimension it names;
  // only the surrounding loaded terrain differs.
  await observe(
    bot,
    () =>
      bot.blockAt(new Vec3(0, 60, 0))?.name === "bedrock" &&
      bot.blockAt(new Vec3(0, 63, 0))?.name === "netherrack" &&
      bot.blockAt(new Vec3(0, 64, 0))?.name === "air" &&
      bot.blockAt(new Vec3(0, 65, 0))?.name === "air",
    "bank and standing pocket",
  );
  if (!(await standStill(context))) throw new Error("Collector did not settle in the bank.");
  if (bot.entity.position.distanceTo(start) >= 0.25) throw new Error("Collector left the arranged starting pocket.");

  const runtime = await openRuntime(context, `netherrack-loaded-scan-${dimension}`);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === "collect_block");
    if (!action) throw new Error("Missing collect action.");
    const itemId = bot.registry.itemsByName.netherrack!.id;
    const before = bot.inventory.count(itemId, null);
    const stateId = bot.registry.blocksByName.netherrack!.minStateId;
    const loadedColumnsBefore = bot.world.getColumns().length;

    // Time the real scanner on these real loaded chunks once, outside the
    // action measurement. No monkey-patching or replacement collection path.
    const scanStarted = performance.now();
    const matches = findLoadedBlockPositions(bot, {
      center: bot.entity.position,
      stateIds: new Set([stateId]),
      limit: 256,
    });
    const scanMs = performance.now() - scanStarted;
    log(`SCAN ${JSON.stringify({ phase: "before", dimension, loadedColumnsBefore, returned: matches.length, scanMs })}`);
    await bot.waitForTicks(20);

    let lastTick = performance.now();
    let maximumGapMs = 0;
    let stalls = 0;
    const onTick = () => {
      const now = performance.now();
      const gapMs = now - lastTick;
      lastTick = now;
      maximumGapMs = Math.max(maximumGapMs, gapMs);
      if (gapMs >= MAX_PHYSICS_GAP_MS) {
        stalls++;
        log(`STALL ${JSON.stringify({ gapMs, gained: bot.inventory.count(itemId, null) - before })}`);
      }
    };
    bot.on("physicsTick", onTick);
    let output;
    try {
      output = await runtime.run(action, { block_name: "netherrack", count: 32, scaffold: true }, signal);
    } finally {
      bot.off("physicsTick", onTick);
    }
    const gained = bot.inventory.count(itemId, null) - before;
    const loadedColumnsAfter = bot.world.getColumns().length;
    // The initial probe can run before all surrounding columns arrive. Record
    // another probe at the end, with its actual coverage, outside the action's
    // physics-gap measurement. Compare full-world probes only at equal coverage.
    const afterScanStarted = performance.now();
    const afterMatches = findLoadedBlockPositions(bot, {
      center: bot.entity.position,
      stateIds: new Set([stateId]),
      limit: 256,
    });
    const afterScanMs = performance.now() - afterScanStarted;
    log(`SCAN ${JSON.stringify({ phase: "after", dimension, loadedColumnsAfter, returned: afterMatches.length, scanMs: afterScanMs })}`);
    const evidence = { dimension, start, loadedColumnsBefore, loadedColumnsAfter, scanMs, afterScanMs, maximumGapMs, stalls, gained, output };
    log(`COLLECTION ${JSON.stringify(evidence)}`);
    return {
      status: output.result.status === "succeeded" && gained >= 32 && stalls === 0 ? "succeeded" : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    await runtime.close();
  }
};
