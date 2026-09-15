import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { botFixture } from "../../src/test-support/bot.ts";
import { clearCrystals, fightPerches, type EndActionCall } from "./ender-dragon.ts";

function output(outcome: string, status: "succeeded" | "failed" = "succeeded", reason: string | null = null) {
  return { action: "end_test", durationMs: 0, result: { status, ...(status === "failed" ? { error: "missed" } : {}),
    combat: { outcome, attacks: 0, healthBefore: null, healthAfter: null, reason } } } as Awaited<ReturnType<EndActionCall>>;
}

for (const strategy of ["mixed", "bow", "melee"] as const) {
  test(`crystal sequence ${strategy} classifies cages, preserves explicit methods and retries a missed shot`, async () => {
    const bot = botFixture({ blocks: { "2,70,0": "iron_bars", "12,71,0": "iron_bars" } });
    for (let i = 0; i < 10; i++) bot.entities[i + 1] = {
      id: i + 1, isValid: true, name: "end_crystal", position: new Vec3(i * 10, 70 + i, 0),
    } as Bot["entity"];
    const calls: Array<{ entity_id: number; weapon: string }> = [];
    let missed = false, interruptedBuild = false, prepared = 0;
    bot.waitForTicks = async () => {};
    const call: EndActionCall = async (name, input) => {
      assert.equal(name, "destroy_end_crystal");
      const shot = input as { entity_id: number; weapon: string };
      calls.push(shot);
      if (shot.weapon === "bow" && !missed) { missed = true; return output("shot_missed", "failed"); }
      if (shot.weapon === "melee" && !interruptedBuild) { interruptedBuild = true; return output("stopped", "failed", "[END_SHELTER_STOPPED] Shelter unsafe"); }
      bot.entities[shot.entity_id]!.isValid = false;
      return output("crystal_destroyed");
    };
    await clearCrystals(bot, call, strategy, async () => { prepared++; });
    const ids = [...new Set(calls.map(c => c.entity_id))];
    assert.deepEqual(ids, strategy === "mixed" ? [3, 4, 5, 6, 7, 8, 9, 10, 1, 2] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(prepared, 10);
    assert.equal(calls.length, strategy === "mixed" ? 12 : 11);
    for (const call of calls) assert.equal(call.weapon, strategy === "mixed" ? (call.entity_id <= 2 ? "melee" : "bow") : strategy);
  });
}

test("confirmed crystal destruction advances the sequence even when its return walk fails", async () => {
  const bot = botFixture();
  for (let i = 1; i <= 10; i++) bot.entities[i] = {
    id: i, isValid: true, name: "end_crystal", position: new Vec3(i * 10, 70, 0),
  } as Bot["entity"];
  const visited: number[] = [];
  bot.waitForTicks = async () => assert.fail("do not wait for an already destroyed crystal");
  const call: EndActionCall = async (_name, input) => {
    const id = (input as { entity_id: number }).entity_id;
    visited.push(id);
    bot.entities[id]!.isValid = false;
    return { ...output("stopped", "failed", "Crystal destroyed; return route failed"),
      request: { evidence: { completion: { kind: "event", observed: true } } },
    } as Awaited<ReturnType<EndActionCall>>;
  };
  await clearCrystals(bot, call, "melee");
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("shared perch caller attacks an early landing, resumes unfinished preparation, then reuses readiness", async () => {
  const bot = botFixture({ dimension: "the_end" });
  const metadata = { 9: 200, 16: 0 };
  const dragon = { id: 42, name: "ender_dragon", isValid: true, metadata } as unknown as Bot["entity"];
  bot.entities[42] = dragon;
  const calls: string[] = [];
  let preparations = 0, attacks = 0;
  const call: EndActionCall = async (name, input) => {
    calls.push(name);
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return output(++preparations === 1 ? "perch_approaching" : "perch_ready");
    metadata[9] = ++attacks === 3 ? 0 : 200 - attacks * 56;
    return output(attacks === 3 ? "dragon_died" : "perch_ended");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.deepEqual(calls, ["prepare_dragon_perch", "attack_dragon_perch", "prepare_dragon_perch", "attack_dragon_perch", "attack_dragon_perch"]);
});

test("perch failures retry preparation and attacking until the dragon dies", async () => {
  const bot = botFixture({ dimension: "the_end" });
  bot.entities[42] = { id: 42, name: "ender_dragon", isValid: true, metadata: { 9: 200, 16: 0 } } as unknown as Bot["entity"];
  let preparations = 0, attacks = 0, waits = 0;
  bot.waitForTicks = async () => { waits++; };
  const call: EndActionCall = async (name, input) => {
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return ++preparations <= 3
      ? output("stopped", "failed", "[PERCH_PREPARATION_DAMAGED] escaped") : output("perch_ready");
    return ++attacks <= 3 ? output("stopped", "failed", "route failed") : output("dragon_died");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.equal(preparations, 7);
  assert.equal(attacks, 4);
  assert.equal(waits, 6);
  const cancelled = new AbortController();
  cancelled.abort(new Error("scenario deadline"));
  await assert.rejects(fightPerches(bot, call, cancelled.signal), /scenario deadline/);
});

test("clouded attack returns to preparation between requests without losing the dragon target", async () => {
  const bot = botFixture({ dimension: "the_end" });
  const dragon = { id: 42, name: "ender_dragon", isValid: true, metadata: { 9: 200, 16: 0 } } as unknown as Bot["entity"];
  bot.entities[42] = dragon;
  let waits = 0, attacks = 0;
  bot.waitForTicks = async (ticks: number) => { waits += ticks; };
  const calls: string[] = [];
  const call: EndActionCall = async (name, input) => {
    calls.push(name);
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return output("perch_ready");
    if (++attacks === 1) return output("stopped", "failed", "[PERCH_PASSAGE_CLOUDED] Wait for clearance");
    return output("dragon_died");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.equal(waits, 20);
  assert.deepEqual(calls, ["prepare_dragon_perch", "attack_dragon_perch", "prepare_dragon_perch", "attack_dragon_perch"]);
});
