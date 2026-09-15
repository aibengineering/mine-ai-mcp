import { readFile } from "node:fs/promises";
import { z } from "zod";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

const paramsSchema = z.object({ disturbance: z.enum(["remove_support", "server_move", "after_collection"]) });

/** The fixture changes the world; the production runtime must supply all diagnostic observations. */
export const run: MineAiScenario = async (context) => {
  if (!(await standStill(context))) return { status: "failed", detail: "Player did not settle on the platform." };
  const { disturbance } = paramsSchema.parse(context.scenario.params);
  const runtime = await openRuntime(context, `incident-${disturbance}`);
  const stop = new AbortController();
  let disturbed = false;
  const arrangeFailure = () => {
    if (disturbance === "after_collection" || disturbed || context.bot.entity.position.x < 2) return;
    disturbed = true;
    // Only scenario arrangement uses operator commands. No diagnostic listeners or debug tools are armed.
    context.bot.chat(disturbance === "remove_support" ? "/fill -2 -55 -2 12 -55 2 air" : "/tp @s 4.5 -54 4.5");
  };
  const healthBefore = context.bot.health;
  const stopAfterFall = () => {
    if (context.bot.health < healthBefore) stop.abort("The fixture observed fall damage.");
  };
  context.bot.on("physicsTick", arrangeFailure);
  context.bot.on("health", stopAfterFall);
  try {
    const action = runtime.actions.find(
      (action) => action.name === (disturbance === "after_collection" ? "collect_block" : "navigate"),
    );
    if (!action) throw new Error("Missing standard actions");
    const request =
      disturbance === "after_collection" ? { block_name: "stone", count: 32, scaffold: false } : { x: 9, y: -54, z: 0 };
    const requestId = runtime.recordActionRequest({
      actionName: action.name,
      rationale: "Exercise the incident fixture",
      requestedAt: new Date().toISOString(),
      request,
    });
    const result = await runtime.run(action, request, AbortSignal.any([context.signal, stop.signal]), requestId);
    if (disturbance === "after_collection") {
      if (result.result.status !== "succeeded")
        return { status: "failed", detail: `Collection did not finish: ${JSON.stringify(result.result)}` };
      disturbed = true;
      context.bot.chat("/damage @s 1 minecraft:generic");
    }
    // A route may stop before the falling player lands. The scenario's external
    // deadline bounds this wait; no gameplay deadline or pass criterion changes.
    while (context.bot.health === healthBefore) {
      context.signal.throwIfAborted();
      await context.bot.waitForTicks(1);
    }
    await runtime.flushIncidents();
    const reference = runtime
      .readRequestIncidents(requestId)
      .findLast((reference) => reference.trigger === "non_entity_damage");
    if (reference?.artifact.kind !== "written")
      return { status: "failed", detail: "Damage produced no readable incident artifact." };
    const source = await readFile(reference.artifact.path, "utf8");
    const related = reference.requestId === requestId || reference.precedingRequestId === requestId;
    const hasPlan = source.includes('"kind":"retained_plan"');
    const hasPhysics = source.includes('"kind":"physics"');
    const hasChangedSupport = source.includes('"kind":"nearby_block_change"');
    const hasServerMove = source.includes('"kind":"server_position_applied"');
    const packetsSupported = !source.includes('"kind":"packet_unavailable"');
    const distinguishes =
      disturbance === "remove_support"
        ? hasChangedSupport
        : disturbance === "server_move"
          ? hasServerMove && !hasChangedSupport
          : reference.requestId === null && reference.precedingRequestId === requestId;
    // Measure the producer's actual work, not whole action wall time or process memory.
    const records = source
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            observationMs?: number;
            recorder?: { samples: number; recordingMs: number };
          },
      );
    const samples = records.filter((record) => record.kind === "physics");
    const observationMs = samples.reduce((sum, record) => sum + (record.observationMs ?? 0), 0);
    const measurements = records[0]?.recorder;
    const detail =
      `${disturbance}: action ${result.result.status}; health ${healthBefore} -> ${context.bot.health}; ` +
      `request linked ${related}; plan ${hasPlan}; physics ${samples.length}; block change ${hasChangedSupport}; server move ${hasServerMove}; ` +
      `observation mean ${(observationMs / samples.length).toFixed(3)} ms; serialization mean ${measurements ? (measurements.recordingMs / measurements.samples).toFixed(3) : "unknown"} ms; artifact ${reference.artifact.kind === "written" ? reference.artifact.path : "missing"}`;
    context.log(detail);
    return {
      status:
        disturbed && related && hasPlan && hasPhysics && distinguishes && packetsSupported ? "succeeded" : "failed",
      detail,
    };
  } finally {
    context.bot.off("physicsTick", arrangeFailure);
    context.bot.off("health", stopAfterFall);
    await runtime.close();
  }
};
