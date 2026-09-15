import { COLLECT_BLOCK, NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { isBurning } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  kind: z.enum(["steady_stream", "released_flow"]),
  action: z.enum(["navigate", "collect"]).default("navigate"),
  target: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  minimumStepUps: z.number().int().nonnegative().default(0),
  requireParkour: z.boolean().default(false),
  lavaCells: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])).min(1),
});

/** Prevention must preserve health; an eventual fire escape cannot erase contact. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params);
  if (!(await standStill(context))) throw new Error("The navigation start did not settle.");
  // Two ordinary Overworld lava updates settle the authored stream before
  // the static test; the other fixture's source remains behind its gate.
  await bot.waitForTicks(80);
  await using runtime = await openRuntime(context, "lava-navigation");
  const navigate = runtime.actions.find(
    (action) => action.name === (params.action === "collect" ? COLLECT_BLOCK : NAVIGATE),
  );
  if (!navigate) throw new Error("The fixture requires navigate.");
  let ticks = 0;
  let deaths = 0;
  let minimumHealth = bot.health;
  let burning = false;
  let fireClaimed = false;
  let released = false;
  let sawAdvance = false;
  let stepUps = 0;
  let parkour = 0;
  let breaks = 0;
  let plans = 0;
  let activeStep: string | null = null;
  let previous = bot.entity.position.clone();
  const frame = () => ({
    ticks,
    position: { ...bot.entity.position },
    health: bot.health,
    delta: bot.entity.position.minus(previous),
    owner: runtime.status().owner,
    action: runtime.status().activeAction?.action,
    activeStep,
    controls: Object.fromEntries(
      (["forward", "back", "left", "right", "jump"] as const).map((control) => [control, bot.getControlState(control)]),
    ),
    swimmingLava: Reflect.get(bot.entity, "isInLava"),
    burning: isBurning(bot),
  });
  const tick = () => {
    ticks++;
    minimumHealth = Math.min(minimumHealth, bot.health);
    burning ||= isBurning(bot);
    fireClaimed ||= runtime.status().activeAction?.action === "fire_reflex";
    if (params.action === "collect" && !released && bot.targetDigBlock?.name === "obsidian") {
      released = true;
      breaks++;
      log(`LAVA_RELEASE ${JSON.stringify(frame())}`);
      bot.chat("/setblock -2 -54 0 air");
    }
    log(`LAVA_NAV_TICK ${JSON.stringify(frame())}`);
    previous = bot.entity.position.clone();
  };
  const death = () => {
    deaths++;
    minimumHealth = 0;
  };
  const change = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (after?.name !== "lava" || before?.stateId === after.stateId) return;
    if (after.position.equals(new Vec3(-1, -54, 0))) sawAdvance = true;
    log(`LAVA_ADVANCE ${JSON.stringify({ ticks, position: after.position, level: after.getProperties().level })}`);
  };
  const stopObserving = runtime.navigation.onEvent((event) => {
    if (event.kind !== "search_slice") log(`LAVA_NAV_EVENT ${JSON.stringify(event)}`);
    if (event.kind === "route_committed") plans++;
    if (event.kind === "step_started") activeStep = event.stepId;
    if (event.kind === "step_phase" && event.phase === "breaking") breaks++;
    if (event.kind === "step_completed" && event.movement === "parkour") parkour++;
    if (event.kind === "step_completed" && event.movement === "step_up") stepUps++;
    if (
      params.kind === "released_flow" &&
      params.action === "navigate" &&
      !released &&
      event.kind === "step_completed" &&
      event.movement === "drop"
    ) {
      released = true;
      log(`LAVA_RELEASE ${JSON.stringify(frame())}`);
      bot.chat("/setblock -2 -54 0 air");
    }
  });
  bot.on("physicsTick", tick);
  bot.on("death", death);
  bot.on("blockUpdate", change);
  try {
    for (const [x, y, z] of params.lavaCells)
      if (bot.blockAt(new Vec3(x, y, z))?.name !== "lava")
        throw new Error(`The fixture's lava was not observed at ${x},${y},${z}.`);
    const [x, y, z] = params.target;
    const output = await runtime.run(
      navigate,
      params.action === "collect"
        ? { block_name: "obsidian", count: 1, x, y, z, scaffold: false }
        : { x, y, z, range: 0.2, dig: true, scaffold: false },
      signal,
    );
    // Observe two more flow updates for the static courses. The dynamic case
    // also covers the long burn after escaping lava, stopping early on death.
    const afterTicks = params.kind === "released_flow" ? 340 : 80;
    for (let waited = 0; waited < afterTicks && deaths === 0; waited++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await runtime.captureIncident();
    const setupObserved =
      params.kind === "steady_stream"
        ? stepUps >= params.minimumStepUps && (!params.requireParkour || parkour > 0)
        : released && sawAdvance && breaks > 0;
    const safe = deaths === 0 && minimumHealth === 20 && !burning && (params.kind === "released_flow" || !fireClaimed);
    // A dynamic hazard may correctly stop the route after a safe withdrawal.
    const acceptableOutcome = params.kind === "released_flow" || output.result.status === "succeeded";
    return {
      status: setupObserved && safe && acceptableOutcome ? "succeeded" : "failed",
      detail: JSON.stringify({
        kind: params.kind,
        setupObserved,
        deaths,
        minimumHealth,
        burning,
        fireClaimed,
        released,
        sawAdvance,
        stepUps,
        parkour,
        breaks,
        plans,
        output: output.result,
        final: frame(),
      }),
    };
  } finally {
    stopObserving();
    bot.off("physicsTick", tick);
    bot.off("death", death);
    bot.off("blockUpdate", change);
  }
}
