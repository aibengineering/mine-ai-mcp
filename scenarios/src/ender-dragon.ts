import type { Bot } from "mineflayer";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { endCombatActionResultSchema } from "../../src/actions/end-combat-result.ts";
import { dragonPhase, entityHealth } from "../../src/world/end-fight.ts";
import { readDragonClouds } from "../../src/world/dragon-hazards.ts";
import { openRuntime, wearArmor } from "./runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "./scenario-client.ts";
import { recordSourceIdentity } from "./source-identity.ts";
import { createCombatController } from "../../src/survival/control/combat/controller.ts";

const paramsSchema = z.object({
  phase: z.enum(["crystals", "perch", "full"]).default("full"),
  crystal_strategy: z.enum(["mixed", "bow", "melee"]).default("mixed"),
  /** How melee climbs: the reusable spiral, or a scaffold pillar straight up beside the tower. */
  crystal_approach: z.enum(["staircase", "pillar"]).default("staircase"),
  call_gap_ticks: z.number().int().nonnegative().default(20),
});
export type EndActionCall = (name: string, input: unknown) => ReturnType<Awaited<ReturnType<typeof openRuntime>>["run"]>;
type CrystalStrategy = z.infer<typeof paramsSchema>["crystal_strategy"];
type CrystalApproach = z.infer<typeof paramsSchema>["crystal_approach"];

/** Native island boundary, also used by the retained defense regression. */
export const prepare: MineAiScenarioPreparation = async context => {
  const { bot, signal } = context;
  await wearArmor(context);
  const pumpkin = bot.inventory.items().find(item => item.name === "carved_pumpkin");
  if (pumpkin) await bot.equip(pumpkin, "head");
  await bot.waitForChunksToLoad();
  for (let t = 0; t < 400 && Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").length < 10; t++) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  if (Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").length !== 10)
    throw new Error("Expected all ten native crystals before the scenario starts");
  if (paramsSchema.parse(context.scenario.params ?? {}).phase !== "perch") return;
  // Arrange only the zero-crystal boundary. Landing and head direction remain native.
  bot.chat("/execute in minecraft:the_end run kill @e[type=end_crystal]");
  for (let t = 0; t < 100 && Object.values(bot.entities).some(e => e.isValid && e.name === "end_crystal"); t++) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  if (Object.values(bot.entities).some(e => e.isValid && e.name === "end_crystal"))
    throw new Error("Zero-crystal setup was not acknowledged");
};

/** Classify observed cages, never seed-specific tower heights. */
export function crystalIsCaged(bot: Bot, crystal: Bot["entity"]): boolean {
  let caged = false;
  const center = crystal.position.floored();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -1; y <= 3; y++) {
    const block = bot.blockAt(center.offset(x, y, z));
    if (!block) throw new Error("Crystal cage area is not loaded: " + crystal.id);
    caged ||= block.name === "iron_bars";
  }
  return caged;
}

/** Shared by crystal-only and full fights. Replay callers can resupply before each tower. */
export async function clearCrystals(bot: Bot, call: EndActionCall, strategy: CrystalStrategy,
  beforeCrystal?: () => Promise<void>, signal?: AbortSignal, approach: CrystalApproach = "staircase"): Promise<void> {
  const targets = Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal")
    .map(entity => ({ entity, caged: crystalIsCaged(bot, entity) }));
  if (targets.length !== 10) throw new Error("Expected ten observed crystals, found " + targets.length);
  targets.sort((a, b) => (strategy === "mixed" ? Number(a.caged) - Number(b.caged) : 0) || a.entity.position.y - b.entity.position.y);
  for (const { entity, caged } of targets) {
    await beforeCrystal?.();
    const weapon = strategy === "mixed" ? (caged ? "melee" : "bow") : strategy;
    for (;;) {
      signal?.throwIfAborted();
      const observed = Object.values(bot.entities).find(candidate => candidate.isValid && candidate.name === "end_crystal" && candidate.position.distanceTo(entity.position) < 2);
      if (!observed) { await bot.waitForTicks(20); continue; }
      const output = await call("destroy_end_crystal", { entity_id: observed.id, weapon, approach });
      const receipt = endCombatActionResultSchema.parse(output.result);
      // A failed descent does not resurrect the crystal. The action retains
      // its native destruction observation independently of route success.
      if (receipt.combat.outcome === "crystal_destroyed" || output.request?.evidence?.completion.observed === true) break;
      if (receipt.combat.outcome === "shot_missed") continue;
      if (receipt.status !== "succeeded") {
        await bot.waitForTicks(20);
        continue;
      }
      await bot.waitForTicks(20);
    }
  }
}

/** One preparation/attack caller for fresh perch fights and complete runs. */
export async function fightPerches(bot: Bot, call: EndActionCall, signal: AbortSignal): Promise<void> {
  let prepared = false;
  for (;;) {
    signal.throwIfAborted();
    const dragon = Object.values(bot.entities).find(e => e.isValid && e.name === "ender_dragon");
    if (!dragon) { await bot.waitForTicks(20); continue; }
    if (entityHealth(bot, dragon) === 0) return;
    if (!prepared) {
      const receipt = endCombatActionResultSchema.parse((await call("prepare_dragon_perch", { entity_id: dragon.id })).result);
      if (receipt.status === "cancelled" && receipt.interruptedBy?.kind === "preempted" && receipt.interruptedBy.by === "recover_footing") continue;
      if (receipt.combat.reason?.startsWith("[PERCH_PASSAGE_CLOUDED]")) {
        await bot.waitForTicks(20);
        continue;
      }
      if (receipt.status !== "succeeded") { await bot.waitForTicks(20); continue; }
      prepared = receipt.combat.outcome === "perch_ready";
      // An early landing yield attacks immediately; unfinished preparation
      // resumes between later requests rather than replacing this window.
    }
    const receipt = endCombatActionResultSchema.parse((await call("attack_dragon_perch", { entity_id: dragon.id })).result);
    if (receipt.status === "cancelled" && receipt.interruptedBy?.kind === "preempted" && receipt.interruptedBy.by === "recover_footing") continue;
    if (receipt.combat.reason?.startsWith("[PERCH_PASSAGE_CLOUDED]")) {
      prepared = false;
      await bot.waitForTicks(20);
      continue;
    }
    if (receipt.status !== "succeeded") { prepared = false; await bot.waitForTicks(20); continue; }
    if (receipt.combat.outcome === "dragon_died") return;
  }
}

/** World goals own success. Retry action failures until death, cancellation or
 * the scenario deadline; a stalled damage chart is evidence, not an exit. */
export const run: MineAiScenario = async context => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const startedAt = Date.now();
  let callSequence = 0;
  let currentAction: string | null = null;
  let stopDiagnostics = () => {};
  await using runtime = await openRuntime(context, "ender-dragon", {
    createCombatController: (...args) => {
      const combat = createCombatController(...args);
      stopDiagnostics = combat.onDecision(event => {
        if (event.kind !== "response" || !event.evidence || typeof event.evidence !== "object" ||
            Array.isArray(event.evidence) || !("boundary" in event.evidence) || event.evidence.boundary !== "dragon_perch") return;
        appendFileSync(path.join(artifacts, "perch-decisions.jsonl"),
          JSON.stringify({ ms: Date.now() - startedAt, callSequence, action: currentAction, ...event.evidence }) + "\n");
      });
      return combat;
    },
  });
  let stage: "crystals" | "perch" = params.phase === "perch" ? "perch" : "crystals";
  let ticks = 0, deaths = 0, lowestHealth = bot.health;
  const snapshot = () => ({ ms: Date.now() - startedAt, stage, health: bot.health, lowestHealth, deaths,
    position: bot.entity.position, grounded: bot.entity.onGround,
    crystals: Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").length,
    dragons: Object.values(bot.entities).filter(e => e.isValid && e.name === "ender_dragon")
      .map(e => ({ id: e.id, health: entityHealth(bot, e), phase: dragonPhase(bot, e) })),
    clouds: readDragonClouds(bot) });
  const observe = () => {
    lowestHealth = Math.min(lowestHealth, bot.health);
    if (++ticks % 20 === 0) appendFileSync(path.join(artifacts, "fight-observations.jsonl"), JSON.stringify(snapshot()) + "\n");
    if (ticks % 100 === 0) log(JSON.stringify(snapshot()));
  };
  const death = () => { deaths++; lowestHealth = 0; stop.abort(new Error("Player died during End scenario")); };
  bot.on("physicsTick", observe);
  bot.on("death", death);
  const call: EndActionCall = async (name, input) => {
    signal.throwIfAborted();
    for (let t = 0; t < params.call_gap_ticks; t++) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    while (runtime.status().busy) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    const action = runtime.actions.find(a => a.name === name);
    if (!action) throw new Error("Missing action " + name);
    const at = Date.now();
    callSequence++;
    currentAction = name;
    appendFileSync(path.join(artifacts, "calls.jsonl"), JSON.stringify({ ms: at - startedAt, callSequence, name, input }) + "\n");
    log("CALL " + name + " " + JSON.stringify(input));
    const output = await runtime.run(action, input, signal);
    appendFileSync(path.join(artifacts, "calls.jsonl"), JSON.stringify({ ms: Date.now() - startedAt, callSequence, name, durationMs: Date.now() - at, output }) + "\n");
    currentAction = null;
    log("RESULT " + name + ": " + output.result.status);
    return output;
  };
  try {
    if (params.phase !== "perch") await clearCrystals(bot, call, params.crystal_strategy, undefined, signal, params.crystal_approach);
    if (params.phase !== "crystals") {
      stage = "perch";
      await fightPerches(bot, call, signal);
    }
    // Keep observation alive through native removal; the runner stops this
    // client as soon as its independently observed world goal is satisfied.
    while (!context.signal.aborted) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    return { status: "succeeded" };
  } catch (error) {
    if (!context.signal.aborted) {
      const failure = { error: String(error), ...snapshot() };
      writeFileSync(path.join(artifacts, "failure.json"), JSON.stringify(failure, null, 2));
      return { status: "failed", detail: JSON.stringify(failure) };
    }
    throw error;
  } finally {
    stopDiagnostics();
    bot.off("physicsTick", observe);
    bot.off("death", death);
  }
};
