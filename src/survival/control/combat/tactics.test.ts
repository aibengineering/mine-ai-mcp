import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { DEFAULT_FOOD_POLICY } from "../../policy/contract.js";
import { Answered } from "../../state/answered.js";
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

test("a regeneration effect admits a blast barrier as it admits every other hide", () => {
  // Water surrounds the bot except toward the creeper, so no retreat heading
  // has safe ground. A barrier is then the only protection left, and it is
  // hide-gated: without food, the observed effect is what permits recovery.
  const blocks: Record<string, string> = {};
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++)
    if (x <= 0 ? x !== 0 || z !== 0 : z !== 0) blocks[`${x},64,${z}`] = "water";
  const bot = botFixture({ blocks, groundY: 63, items: [{ name: "cobblestone", count: 8 }] });
  bot.food = 10;
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3.5, 64, 0.5) } as typeof bot.entity;
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: { name: "skeleton" }, policy: { combat: DEFAULT_COMBAT_POLICY, food: DEFAULT_FOOD_POLICY },
    survival: { answered: new Answered() }, footingRecovery: { needed: false }, reportDecision: () => {} } as unknown as FightScene;
  const weapons = { projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    contact: () => null, itemUse: { shieldRaised: false, drawingBow: false } } as unknown as FightWeapons;
  assert.equal(new CombatTactics(new AbortController().signal).observe(scene, weapons).kind, "brace_blast");
  const regeneration = bot.registry.effectsByName.Regeneration!.id;
  Reflect.set(bot.entity.effects, regeneration, { id: regeneration, amplifier: 0, duration: 100 });
  assert.deepEqual(new CombatTactics(new AbortController().signal).observe(scene, weapons),
    { kind: "blast_barrier", cell: { x: 1, y: 64, z: 0 } });
});
