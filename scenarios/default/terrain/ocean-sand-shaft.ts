import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** One ordinary collection request from water; never wait for dry footing first. */
export const run: MineAiScenario = async (context) => {
  const runtime = await openRuntime(context, "ocean-sand-shaft");
  const target = new Vec3(1414, 59, -91);
  const started = Date.now();
  const events: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let minY = context.bot.entity.position.y;
  let maxY = minY;
  let nextSample = started + 5_000;
  let captured = false;
  let capture: Promise<unknown> | undefined;
  const unsubscribe = runtime.navigation.onEvent((event) => {
    events[event.kind] = (events[event.kind] ?? 0) + 1;
    if (event.kind === "search_started") reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  });
  const observe = () => {
    minY = Math.min(minY, context.bot.entity.position.y);
    maxY = Math.max(maxY, context.bot.entity.position.y);
    if (Date.now() >= nextSample) {
      nextSample = Date.now() + 5_000;
      context.log(JSON.stringify({ elapsedMs: Date.now() - started, position: context.bot.entity.position,
        target: context.bot.blockAt(target)?.name, minY, maxY, events, reasons }));
    }
    if (!captured && Date.now() - started >= 30_000) {
      captured = true;
      capture = runtime.captureIncident().then((result) => context.log(JSON.stringify({ checkpointCapture: result })));
    }
  };
  context.bot.on("physicsTick", observe);
  try {
    const block = context.bot.blockAt(target)?.name;
    context.log(JSON.stringify({ startingPosition: context.bot.entity.position, target: block }));
    if (block !== "sand") return { status: "failed", detail: `Seed fixture mismatch: expected sand at ${target}, observed ${block}.` };
    const collect = runtime.actions.find((action) => action.name === "collect_block")!;
    const output = await runtime.run(collect, {
      block_name: "sand", count: 1, x: target.x, y: target.y, z: target.z,
      scaffold: true, allow_full_inventory: true,
    }, context.signal);
    return { status: output.result.status === "succeeded" ? "succeeded" : "failed",
      detail: JSON.stringify({ output, events, reasons, minY, maxY }) };
  } finally {
    context.bot.off("physicsTick", observe);
    unsubscribe();
    await capture;
    await runtime.close();
  }
};
