import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { openRuntime } from "../../src/runtime.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { observe } from "../../default/nether/hazards/pit.ts";
import { hurt, readEncounters } from "./reflex.ts";

/** One real request remains subject to normal survival policy for an entire native night. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await recordSourceIdentity();
  assert.ok(await hurt(context, 7), "The night starts at seven observed health.");
  bot.chat("/time set 13000");
  await observe(bot, () => bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 13100, "nightfall");
  await using runtime = await openRuntime(context, "full-night-request");
  const died = new AbortController();
  let minimumHealth = bot.health;
  const death = () => died.abort(new Error("The bot died during the night."));
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  bot.on("death", death);
  bot.on("physicsTick", tick);
  const joined = AbortSignal.any([signal, died.signal]);
  try {
    const hunt = runtime.actions.find((action) => action.name === "collect_mob_drop")!;
    // There are no cows. The declared 550-second observation covers 11,000
    // vanilla night ticks; no repeated model action can hide a cancelled job.
    let handoffs = 0;
    const pending = runtime.run(
      hunt,
      { mob_name: "cow", drop_name: "leather", count: 1, observe_for_ms: 550_000 },
      joined,
    );
    void pending.then(() => {
      handoffs++;
    });
    bot.chat("/execute as @e[tag=night_ring] run data merge entity @s {NoAI:0b}");
    const started = Date.now();
    const startingAge = bot.time.age;
    let ticks = 0;
    while (bot.time.timeOfDay >= 13000) {
      joined.throwIfAborted();
      await bot.waitForTicks(1);
      if (++ticks % 1200 === 0)
        log(
          JSON.stringify({
            ticks,
            time: bot.time.timeOfDay,
            health: bot.health,
            handoffs,
            owner: runtime.status().owner,
          }),
        );
    }
    const output = await pending;
    const encounters = await readEncounters(context, runtime);
    const worldTicks = bot.time.age - startingAge;
    const evidence = {
      output,
      handoffs,
      ticks,
      worldTicks,
      elapsedMs: Date.now() - started,
      minimumHealth,
      died: died.signal.aborted,
      dawn: bot.time.timeOfDay,
      encounters,
    };
    const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
    await writeFile(path.join(artifacts, "full-night-request.json"), JSON.stringify(evidence, null, 2));
    assert.equal(died.signal.aborted, false);
    assert.equal(handoffs, 1, "Exactly one request returns to the caller.");
    assert.notEqual(output.result.status, "cancelled", JSON.stringify(output));
    // Client physics can skip ticks under load. The native world clock owns dawn.
    assert.ok(worldTicks >= 10_800 && bot.time.timeOfDay < 13000, "The native clock must reach dawn.");
    return { status: "succeeded", detail: JSON.stringify(evidence) };
  } finally {
    bot.off("death", death);
    bot.off("physicsTick", tick);
  }
};
