import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const sources = [new Vec3(32, -56, 0), new Vec3(48, -56, 1), new Vec3(64, -56, -1)];
const gates = sources.map((source) => source.offset(0, -1, 0));
const crossings = sources.map((source) => new Vec3(source.x, -59, 0));
const goal = new Vec3(78.5, -59, 0.5);

/** Arrangement check only: a conservative, level walking route after native flow settles. */
function dryRouteRemains(bot: MineAiScenarioContext["bot"]): boolean {
  const queue = [new Vec3(0, -59, 0)];
  const seen = new Set(["0,0"]);
  for (let index = 0; index < queue.length; index++) {
    const cell = queue[index];
    if (cell.x === 78 && cell.z === 0) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = cell.offset(dx, 0, dz);
      const key = `${next.x},${next.z}`;
      if (seen.has(key) || next.x < 0 || next.x > 78 || Math.abs(next.z) > 14) continue;
      seen.add(key);
      if (bot.blockAt(next)?.name !== "air" || bot.blockAt(next.offset(0, 1, 0))?.name !== "air") continue;
      if (bot.blockAt(next.offset(0, -1, 0))?.boundingBox !== "block") continue;
      queue.push(next);
    }
  }
  return false;
}

/** One request must survive a changed route and still deliver the requested arrival. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal, log } = context;
  if (!(await standStill(context))) throw new Error("The navigation start did not settle.");
  await using runtime = await openRuntime(context, "spreading-lava-obstacle-course");
  const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
  if (!navigate) throw new Error("The fixture requires navigate.");
  if (!sources.every((source) => bot.blockAt(source)?.name === "lava") ||
      !gates.every((gate) => bot.blockAt(gate)?.name === "stone"))
    throw new Error("The contained lava sources and release gates were not observed.");

  let ticks = 0;
  let plans = 0;
  let clearAtPlan = false;
  let released = false;
  const openedGates = new Set<number>();
  const floodedCrossings = new Set<number>();
  let lastFlowTick = 0;
  let passedBeforeFlood = false;
  let lavaContact = false;
  let burning = false;
  let deaths = 0;
  let minimumHealth = bot.health;
  let activeStep: string | null = null;
  const health = () => { minimumHealth = Math.min(minimumHealth, bot.health); };
  const death = () => { deaths++; minimumHealth = 0; };
  const tick = () => {
    ticks++;
    health();
    lavaContact ||= isInLava(bot);
    burning ||= isBurning(bot);
    passedBeforeFlood ||= crossings.some((crossing, index) =>
      bot.entity.position.x >= crossing.x && !floodedCrossings.has(index),
    );
    log(`LAVA_REROUTE_TICK ${JSON.stringify({
      ticks, position: bot.entity.position, health: bot.health,
      inLava: isInLava(bot), burning: isBurning(bot),
      owner: runtime.status().owner, activeStep,
      controls: Object.fromEntries(
        (["forward", "back", "left", "right", "jump", "sprint"] as const)
          .map((control) => [control, bot.getControlState(control)]),
      ),
    })}`);
  };
  const change = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (!after || before?.stateId === after.stateId) return;
    const gateIndex = gates.findIndex((gate) => after.position.equals(gate));
    if (released && gateIndex !== -1 && after.name === "air") openedGates.add(gateIndex);
    if (after.name !== "lava") return;
    lastFlowTick = ticks;
    const crossingIndex = crossings.findIndex((crossing) => after.position.equals(crossing));
    if (released && crossingIndex !== -1) floodedCrossings.add(crossingIndex);
    log(`LAVA_REROUTE_FLOW ${JSON.stringify({ ticks, position: after.position, level: after.getProperties().level })}`);
  };
  const stopObserving = runtime.navigation.onEvent((event) => {
    if (event.kind !== "search_slice") log(`LAVA_REROUTE_NAV ${JSON.stringify(event)}`);
    if (event.kind === "step_started") activeStep = event.stepId;
    if (event.kind !== "route_committed") return;
    plans++;
    if (released) return;
    // Verify the straight approach really is clear at commitment. Release on
    // the first plan even if a future planner already predicts the spread.
    clearAtPlan = Array.from({ length: 79 }, (_, x) => x).every((x) =>
      [-59, -58].every((y) => bot.blockAt(new Vec3(x, y, 0))?.name === "air"),
    );
    released = true;
    log(`LAVA_REROUTE_RELEASE ${JSON.stringify({ ticks, clearAtPlan, position: bot.entity.position, planId: event.planId })}`);
    for (const gate of gates) bot.chat(`/setblock ${gate.x} ${gate.y} ${gate.z} air`);
  });
  bot.on("physicsTick", tick);
  bot.on("health", health);
  bot.on("death", death);
  bot.on("blockUpdate", change);
  try {
    const output = await runtime.run(navigate, { x: 78, y: -59, z: 0, range: 0.2, dig: false, scaffold: false }, signal);
    // Observe at least eight seconds after arrival and require a quiet flow
    // window too: arrival must not outrun the arena's final hazard footprint.
    for (let waited = 0; waited < 320 && deaths === 0; waited++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      if (waited >= 159 && floodedCrossings.size === 3 && ticks - lastFlowTick >= 160) break;
    }
    await runtime.captureIncident();
    const settled = floodedCrossings.size === 3 && ticks - lastFlowTick >= 160;
    const connectedAfterSpread = settled && dryRouteRemains(bot);
    const setupObserved = clearAtPlan && released && openedGates.size === 3 &&
      floodedCrossings.size === 3 && !passedBeforeFlood && connectedAfterSpread;
    const safe = deaths === 0 && minimumHealth === 20 && !lavaContact && !burning;
    const arrived = output.result.status === "succeeded" && bot.entity.position.distanceTo(goal) <= 0.8;
    log(`LAVA_REROUTE_RESULT ${JSON.stringify({ output: output.result, setupObserved, clearAtPlan,
      openedGates: [...openedGates], floodedCrossings: [...floodedCrossings], passedBeforeFlood,
      settled, connectedAfterSpread, plans })}`);
    return {
      status: setupObserved && safe && arrived ? "succeeded" : "failed",
      detail: `setup=${setupObserved}; arrived=${arrived}; healthMin=${minimumHealth}; lava=${lavaContact}; burning=${burning}; deaths=${deaths}; plans=${plans}; action=${output.result.status}`,
    };
  } finally {
    stopObserving();
    bot.off("physicsTick", tick);
    bot.off("health", health);
    bot.off("death", death);
    bot.off("blockUpdate", change);
  }
}
