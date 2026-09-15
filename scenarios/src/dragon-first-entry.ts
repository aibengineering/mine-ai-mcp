import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dragonPhase, entityHealth } from "../../src/world/end-fight.ts";
import { openRuntime } from "./runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "./scenario-client.ts";
import { recordSourceIdentity } from "./source-identity.ts";
import { clearCrystals, fightPerches } from "./ender-dragon.ts";
import { recordedLoadoutSchema, restoreRecordedLoadout } from "./recorded-loadout.ts";

const paramsSchema = z.object({
  loadout: recordedLoadoutSchema,
});
const junk = ["leather", "coal", "gravel", "oak_log", "porkchop", "stone_button", "mossy_stone_bricks", "smooth_stone_slab", "string", "gunpowder", "furnace", "blaze_powder"];

/** Setup restores recorded slots/durability, which Mine Labs' inventory list cannot express. */
export const prepare: MineAiScenarioPreparation = async ({ bot, scenario, signal, log }) => {
  const { loadout } = paramsSchema.parse(scenario.params);
  await restoreRecordedLoadout(bot, loadout, signal);
  if (bot.health !== 20 || !bot.entity.onGround || bot.blockAt(bot.entity.position)?.name !== "air")
    throw new Error("First-entry fixture did not start healthy on clear island footing");
  log(JSON.stringify({ verifiedLoadout: loadout, position: bot.entity.position, health: bot.health, food: bot.food }));
};

/** A small scripted caller: mine carried scaffolding, clear towers, then prepare/attack perches. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const staging = bot.entity.position.floored();
  const scaffoldCount = () => bot.inventory.items().filter(i => i.name === "end_stone").reduce((n, i) => n + i.count, 0);
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
  // A separate directory per trial plus a larger cap keeps the first failure's
  // physical window. No later death/recovery loop can prune it from this run.
  await using runtime = await openRuntime(context, `dragon-first-entry-${context.scenario.world.seed}`, {
    incidents: { retention: { days: 5, maxBytes: 512 * 1024 * 1024 } },
  });
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  let deaths = 0, lowestHealth = bot.health, calls = 0, stage = "preparing_inventory";
  const snapshot = () => ({ at: new Date().toISOString(), stage, health: bot.health, food: bot.food,
    position: bot.entity.position.clone(), velocity: bot.entity.velocity.clone(), onGround: bot.entity.onGround,
    held: bot.heldItem?.name ?? null, water: bot.inventory.items().filter(i => i.name === "water_bucket" || i.name === "bucket").map(i => ({ name: i.name, slot: i.slot })),
    crystals: Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").map(e => ({ id: e.id, position: e.position.clone() })),
    dragons: Object.values(bot.entities).filter(e => e.isValid && e.name === "ender_dragon").map(e => ({ id: e.id, health: entityHealth(bot, e), phase: dragonPhase(bot, e) })),
  });
  let deathSnapshot: ReturnType<typeof snapshot> | null = null;
  const death = () => {
    deaths++;
    lowestHealth = 0;
    deathSnapshot ??= snapshot();
    stop.abort(new Error("First player death; stop this trial and retain its incident"));
  };
  let ticks = 0;
  const observe = () => {
    lowestHealth = Math.min(lowestHealth, bot.health);
    if (++ticks % 20 === 0) appendFileSync(path.join(artifacts, "fight-observations.jsonl"), JSON.stringify(snapshot()) + "\n");
    if (ticks % 200 === 0) log(JSON.stringify(snapshot()));
  };
  bot.on("death", death);
  bot.on("physicsTick", observe);
  const call = async (name: string, input: unknown) => {
    signal.throwIfAborted();
    while (runtime.status().busy) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    const action = runtime.actions.find(a => a.name === name);
    if (!action) throw new Error(`Missing action ${name}`);
    const start = snapshot();
    log(`CALL ${++calls} ${name} ${JSON.stringify(input)}`);
    const output = await runtime.run(action, input, AbortSignal.any([signal, AbortSignal.timeout(180_000)]));
    appendFileSync(path.join(artifacts, "fight-calls.jsonl"), JSON.stringify({ name, input, start, end: snapshot(), output }) + "\n");
    log(`RESULT ${name} ${output.result.status}`);
    signal.throwIfAborted();
    return output;
  };
  const requireCall = async (name: string, input: unknown) => {
    const output = await call(name, input);
    // Partial collection is usable when the inventory really gained supplies.
    if (name === "collect_block" && output.result.status === "partial" &&
      output.result.error?.startsWith("[DROP_RECOVERY_EXHAUSTED]")) return output;
    if (output.result.status !== "succeeded") throw new Error(`${name} stopped: ${JSON.stringify(output.result)}`);
    return output;
  };
  try {
    const status = await requireCall("view_status", {});
    if (!status.survivalPolicy) throw new Error("Survival policy revision unavailable before fight setup");
    await requireCall("set_survival_policy", { operation: "set", expected_revision: status.survivalPolicy.revision,
      changes: { combat: { engagement: "defend_only", hide: "never" } }, lifetime: { kind: "session" },
      reason: "Reproduce Claude's first End fight: defend against endermen without pursuing or hiding." });
    await requireCall("drop_item", { items: junk.map(item_name => ({ item_name })), in_a_hole: true });
    stage = "crystals";
    await clearCrystals(bot, call, "melee", async () => {
      while (scaffoldCount() < 64) {
        const before = scaffoldCount();
        await requireCall("collect_block", { block_name: "end_stone", count: Math.min(32, 64 - before) });
        if (scaffoldCount() <= before) throw new Error("End-stone resupply made no inventory progress");
      }
      await requireCall("navigate", { x: staging.x, y: staging.y, z: staging.z, range: 1, build: true });
    });
    stage = "perches";
    await fightPerches(bot, call, signal);
    const dragon = Object.values(bot.entities).find(e => e.isValid && e.name === "ender_dragon");
    for (let t = 0; t < 240 && dragon?.isValid; t++) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    if (dragon?.isValid || bot.health <= 0 || deaths) throw new Error("Native death/removal and player survival were not both observed");
    const result = { status: "succeeded" as const, detail: JSON.stringify({ deaths, lowestHealth, calls, final: snapshot() }) };
    writeFileSync(path.join(artifacts, "fight-result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (context.signal.aborted) throw error;
    // A dry client-side impact can precede the server's health/death packet.
    // Observe that short settlement before freezing the failure summary.
    await new Promise(resolve => setTimeout(resolve, 250));
    const incident = await runtime.captureIncident();
    await runtime.flushIncidents();
    const result = { status: "failed" as const, detail: JSON.stringify({ error: String(error), deaths, lowestHealth, calls, death: deathSnapshot, final: snapshot() }) };
    writeFileSync(path.join(artifacts, "fight-result.json"), JSON.stringify(result, null, 2));
    writeFileSync(path.join(artifacts, "failure-incident.json"), JSON.stringify(incident, null, 2));
    return result;
  } finally {
    bot.off("death", death);
    bot.off("physicsTick", observe);
  }
};
