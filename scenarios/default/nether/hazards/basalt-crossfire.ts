import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { readRecentEventsResultSchema } from "@aibengineering/mine-ai-mcp";
import { declaredEntitiesArranged, openRuntime, standStill, wearArmor } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { observe } from "./pit.ts";
import { isAngry } from "./observe.ts";

const paramsSchema = z.strictObject({
  trial: z.enum(["traverse", "wounded_gaze"]).default("traverse"),
});

const encounterSchema = z.object({
  response: z.string(),
  outcome: z.string(),
  explosions: z.number(),
  healthAfter: z.number(),
  interrupted: z.object({ action: z.string() }).nullable(),
});

/** Independent inspection of the full two-high shell, cap, floor, and standing body. */
function enclosed(bot: Parameters<MineAiScenario>[0]["bot"]): boolean {
  const feet = bot.entity.position.floored();
  const shell = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    .flatMap((side) => [feet.plus(side), feet.plus(side).offset(0, 1, 0)])
    .concat(feet.offset(0, 2, 0), feet.offset(0, -1, 0));
  return (
    bot.entity.onGround &&
    shell.every((p) => bot.blockAt(p)?.boundingBox === "block") &&
    [feet, feet.offset(0, 1, 0)].every((p) => bot.blockAt(p)?.boundingBox === "empty")
  );
}

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  await bot.waitForChunksToLoad();
  if (bot.blockAt(new Vec3(36, 100, 0))?.name !== "emerald_block")
    throw new Error("The declared basalt arena is not built around the start.");
  await declaredEntitiesArranged(context);
  if (!(await standStill(context))) throw new Error("Could not settle on the basalt start.");
  await wearArmor(context);
  let provokedId: number | null = null;
  if (params.trial === "wounded_gaze") {
    const target = Object.values(bot.entities).find((e) => e.name === "enderman")!;
    bot.chat(`/data merge entity @e[type=minecraft:enderman,limit=1] {NoAI:0b}`);
    await bot.lookAt(target.position.offset(0, 2.6, 0), true);
    await observe(bot, () => isAngry(bot, target), "native enderman provoked by gaze");
    provokedId = target.id;
  }

  let deaths = 0;
  let minimumHealth = bot.health;
  let inLava = false;
  let onMagma = false;
  let endermanAttackedFirst = false;
  const attackers = new Set<number>();
  const seen = new Set<string>();
  const damage: unknown[] = [];
  const samples: unknown[] = [];
  const started = Date.now();
  let lastSample = 0;
  const runtime = await openRuntime(context, "basalt-crossfire");
  const stopNavigation = runtime.navigation.onEvent((event) => {
    if (["search_started", "step_started", "step_completed", "step_failed", "run_settled"].includes(event.kind))
      log(`Crossfire navigation: ${JSON.stringify(event)}`);
  });
  const health = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source) attackers.add(source.id);
    if (
      entity.name === "enderman" &&
      source?.id === bot.entity.id &&
      entity.id !== provokedId &&
      !attackers.has(entity.id)
    )
      endermanAttackedFirst = true;
    damage.push({
      ms: Date.now() - started,
      target: entity.name,
      id: entity.id,
      source: source?.name,
      sourceId: source?.id,
      position: entity.position.clone(),
      owner: runtime.status().activeAction?.action,
    });
  };
  const tick = () => {
    const position = bot.entity.position;
    inLava ||= Reflect.get(bot.entity, "isInLava") === true;
    onMagma ||= bot.entity.onGround && bot.blockAt(position.offset(0, -0.1, 0))?.name === "magma_block";
    for (const e of Object.values(bot.entities))
      if (e.isValid && e.position.distanceTo(position) < 32 && e.name) seen.add(e.name);
    if (Date.now() - lastSample < 1000) return;
    lastSample = Date.now();
    samples.push({
      ms: Date.now() - started,
      position: position.clone(),
      health: bot.health,
      owner: runtime.status().activeAction?.action,
      inLava: Reflect.get(bot.entity, "isInLava"),
      mobs: Object.values(bot.entities)
        .filter((e) => ["magma_cube", "enderman", "ghast", "fireball"].includes(e.name ?? ""))
        .map((e) => ({ id: e.id, name: e.name, position: e.position.clone() })),
    });
  };
  bot.on("health", health);
  bot.on("death", death);
  bot.on("entityHurt", hurt);
  bot.on("physicsTick", tick);
  try {
    bot.chat("/execute as @e[type=!minecraft:player,distance=..40] run data merge entity @s {NoAI:0b}");
    const action = runtime.actions.find((a) => a.name === "navigate")!;
    const travel = await runtime.run(action, { x: 36, y: 101, z: 0, range: 1 }, signal);
    // Observe damage after arrival or handoff, and independently verify a claimed shelter.
    let coveredTicks = 0;
    for (let tick = 0; tick < 40; tick++) {
      await bot.waitForTicks(1);
      if (enclosed(bot)) coveredTicks++;
    }
    const read = runtime.actions.find((a) => a.name === "read_recent_events")!;
    const events = await runtime.run(read, { limit: 50 }, signal);
    const encounters = readRecentEventsResultSchema
      .parse(events.result)
      .events.flatMap((e) =>
        e.type === "survival_outcome" && e.payload.source === "hostile_reflex" ? [e.payload] : [],
      );
    const arrived = bot.entity.position.distanceTo(new Vec3(36.5, 101, 0.5)) < 2;
    const responses = encounters.map((e) => {
      const receipt = z
        .object({
          outcome: encounterSchema.omit({ interrupted: true }),
          interrupted: encounterSchema.shape.interrupted,
        })
        .parse(e.evidence);
      return { ...receipt.outcome, interrupted: receipt.interrupted };
    });
    const handoff = responses.findLast((response) => response.interrupted?.action === "navigate");
    // Classify handoff evidence for diagnosis. Only arrival satisfies the travel goal.
    const blastHandoff =
      travel.result.status === "cancelled" &&
      handoff?.outcome === "target_died" &&
      handoff.explosions > 0 &&
      bot.health >= 12 &&
      bot.entity.onGround;
    const sheltered =
      travel.result.status === "cancelled" &&
      handoff?.outcome === "hidden" &&
      handoff.healthAfter >= 18 &&
      coveredTicks === 40;
    const outcome =
      travel.result.status === "succeeded" && arrived
        ? "arrived"
        : sheltered
          ? "sheltered"
          : blastHandoff
            ? "blast_handoff"
            : "incomplete";
    const required =
      params.trial === "wounded_gaze"
        ? ["magma_cube", "enderman", "ghast"]
        : ["magma_cube", "enderman", "ghast", "fireball"];
    const exercised = required.every((name) => seen.has(name));
    const passed =
      arrived &&
      bot.health > 0 &&
      exercised &&
      deaths === 0 &&
      !inLava &&
      !onMagma &&
      !endermanAttackedFirst &&
      bot.game.dimension === "the_nether";
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        arrived,
        outcome,
        sheltered,
        blastHandoff,
        coveredTicks,
        exercised,
        deaths,
        minimumHealth,
        inLava,
        onMagma,
        endermanAttackedFirst,
        seen: [...seen],
        travel,
        encounters,
      }),
    };
  } finally {
    log(`Crossfire trace: ${JSON.stringify({ samples, damage })}`);
    stopNavigation();
    bot.off("health", health);
    bot.off("death", death);
    bot.off("entityHurt", hurt);
    bot.off("physicsTick", tick);
    await runtime.close();
  }
};
