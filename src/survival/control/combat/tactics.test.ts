import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";
import type { FightScene } from "../../responses/fight/scene.js";
import type { FightWeapons } from "../../responses/fight/weapons.js";
import { CombatTactics } from "./tactics.js";

test("a newly closing creeper cancels and drains the old effect before escape gets a fresh signal", async () => {
  const bot = botFixture({ groundY: 63 });
  bot.entity.position.set(0, 64, 0);
  bot.blockAt = (position => ({ name: position.y < 64 ? "stone" : "air", boundingBox: position.y < 64 ? "block" : "empty" })) as typeof bot.blockAt;
  const tactics = new CombatTactics(new AbortController().signal);
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: { name: "skeleton" }, policy: { combat: { retreat: true } }, footingRecovery: { needed: false },
    reportDecision: () => {} } as unknown as FightScene;
  const weapons = { projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    itemUse: { shieldRaised: false } } as unknown as FightWeapons;
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  let drained = false;
  const running = tactics.run({ kind: "act" }, async () => {
    const signal = tactics.signal;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    await cleanup;
    drained = true;
    signal.throwIfAborted();
  });
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3, 64, 0) } as typeof bot.entity;
  const decision = tactics.observe(scene, weapons);
  assert.equal(decision.kind, "escape");
  assert.equal(stopped, true);
  assert.equal(drained, false);
  release();
  assert.deepEqual(await running, { kind: "interrupted" });
  await tactics.run(decision, async () => {
    assert.equal(drained, true);
    assert.equal(tactics.signal.aborted, false);
    tactics.observe(scene, weapons);
    assert.equal(tactics.signal.aborted, false, "the escape does not interrupt itself");
  });
  const failedRelease = tactics.run({ kind: "act" }, async () => {
    await new Promise<void>(resolve => tactics.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("shield release failed");
  });
  tactics.observe(scene, weapons);
  await assert.rejects(failedRelease, /shield release failed/,
    "tactical cancellation cannot hide a cleanup failure and start another effect");
});

test("a reachable contact is priced as melee before a distant quarry's bow commitment", () => {
  const bot = botFixture({ groundY: 63 });
  bot.entity.position.set(0, 64, 0);
  bot.blockAt = (position => ({ name: position.y < 64 ? "stone" : "air", boundingBox: position.y < 64 ? "block" : "empty" })) as typeof bot.blockAt;
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3.8, 64, 0) } as typeof bot.entity;
  const tactics = new CombatTactics(new AbortController().signal);
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: { name: "skeleton" }, policy: { combat: { retreat: true, melee: true } }, footingRecovery: { needed: false },
    reportDecision: () => {} } as unknown as FightScene;
  let contact = bot.entity as typeof bot.entity | null;
  const weapons = { projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    contact: () => contact, itemUse: { shieldRaised: false, drawingBow: false } } as unknown as FightWeapons;
  assert.equal(tactics.observe(scene, weapons).kind, "act", "a ready contact does not commit to the quarry's bow draw");
  contact = null;
  assert.equal(tactics.observe(scene, weapons).kind, "escape", "without that contact the exposed bow draw still needs distance");
});
