import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { TestEndCombat } from "../../test-support/combat.js";
import { DragonShotObservation } from "../../survival/perception/combat/dragon-shot.js";
import type { FootingRecovery } from "../../survival/responses/footing.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { createShootDragonAction } from "./index.js";
import { shootDragonInputSchema } from "./contract.js";

function fixture() {
  let drawing = false, releases = 0;
  const dragon = { id: 42, name: "ender_dragon", isValid: true, position: new Vec3(30, 84, 0),
    velocity: new Vec3(0, 0, 0), yaw: 0, metadata: { 9: 190, 16: 1 } } as unknown as Bot["entity"];
  const bot = botFixture({ dimension: "the_end", groundY: 63, entities: { 42: dragon },
    items: [{ name: "bow", count: 1 }, { name: "arrow", count: 3 }] }, {
    clearControlStates() {}, setQuickBarSlot() { drawing = false; },
    activateItem() { drawing = true; }, deactivateItem() { if (drawing) releases++; drawing = false; },
  });
  const end = new TestEndCombat(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  return { bot, dragon, end, releases: () => releases };
}

test("shoot_dragon refuses absent arrows and arrow-immune perches without releasing", async () => {
  const f = fixture(), timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  try {
    f.bot.inventory.items().pop();
    using missing = new DragonShotObservation(f.bot, 42);
    assert.equal((await f.end.shootDragon(new AbortController().signal, missing)).outcome, "weapon_unavailable");
    f.bot.inventory.items().push({ name: "arrow", count: 1 } as never);
    Reflect.set(f.dragon.metadata, 16, 5);
    using perched = new DragonShotObservation(f.bot, 42);
    assert.match((await f.end.shootDragon(new AbortController().signal, perched)).reason!, /DRAGON_PERCHED/);
    assert.equal(f.releases(), 0);
  } finally { clearInterval(timer); }
});

test("caller cancellation during the draw does not release an arrow", async () => {
  const f = fixture(), stop = new AbortController();
  f.bot.activateItem = () => { stop.abort("cancelled while drawing"); };
  const timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  try {
    using observation = new DragonShotObservation(f.bot, 42);
    await assert.rejects(f.end.shootDragon(stop.signal, observation));
    assert.equal(observation.attacks, 0);
    assert.equal(f.releases(), 0);
  } finally { clearInterval(timer); }
});

test("a released shot survives takeover, reports health loss, and is never fired twice", async () => {
  const f = fixture(), runner = new ActionRunner();
  let first: DragonShotObservation | undefined, attempts = 0;
  const timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  try {
    const combat = { async runEnd(request, signal) {
      if (request.kind !== "dragon_bow") throw Error("wrong request");
      attempts++;
      if (attempts === 1) {
        first = request.observation;
        first.released(10);
        const cancelled = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        assert.equal(runner.claim("hostile", "Incoming hostile", async () => {
          Reflect.set(f.dragon.metadata, 9, 187);
          f.bot.emit("entityUpdate", f.dragon);
          return { value: null, continuation: { kind: "resume" as const } };
        }).kind, "claimed");
        await cancelled;
        signal.throwIfAborted();
      }
      assert.equal(request.observation, first);
      return f.end.shootDragon(signal, request.observation);
    } } as CombatController;
    const result = await runner.run(createShootDragonAction(f.bot, combat), { entity_id: 42 });
    assert.equal(result.result.status, "succeeded");
    assert.equal(first!.attacks, 1);
    assert.equal(first!.damageObserved, 3);
    assert.equal(f.releases(), 0);
    assert.equal(f.bot.listenerCount("entityDead"), 0);
  } finally { clearInterval(timer); }
});

test("disappearance and numeric entity-id reuse do not manufacture a bow hit", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.bot.entities[42] = { ...f.dragon, metadata: { 9: 0, 16: 9 } } as unknown as Bot["entity"];
  f.bot.emit("entityUpdate", f.bot.entities[42]);
  assert.equal(observation.loaded, false);
  assert.equal(observation.damageObserved, 0);
  assert.equal(observation.died, false);
  assert.equal(shootDragonInputSchema.parse({ entity_id: 42 }).hitbox_margin, 0.5);
  assert.equal(shootDragonInputSchema.safeParse({ entity_id: 42, hitbox_margin: 2 }).success, false);
  using deadDragon = new DragonShotObservation(f.bot, 42);
  assert.equal(deadDragon.died, true, "already observed zero health survives the gap between requests");
  f.bot.entities[42]!.name = "cow";
  using wrongSpecies = new DragonShotObservation(f.bot, 42);
  assert.equal(wrongSpecies.died, false);
});

test("native death remains terminal when its health metadata packet is still stale", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.bot.emit("entityDead", f.dragon);
  f.bot.emit("physicsTick");
  assert.equal(observation.died, true);
  assert.equal(observation.healthAfter, 0);
});

test("a released arrow without health loss is a miss and is not retried", async () => {
  const f = fixture(), timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  try {
    using observation = new DragonShotObservation(f.bot, 42);
    const result = await f.end.shootDragon(new AbortController().signal, observation);
    assert.equal(result.outcome, "shot_missed");
    assert.equal(result.attacks, 1);
    assert.equal(f.releases(), 1);
    assert.equal(observation.damageObserved, 0);
  } finally { clearInterval(timer); }
});

test("a perch update during the final aim cancels the charged arrow", async () => {
  const f = fixture(), timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  let looks = 0;
  f.bot.look = async () => { if (++looks === 22) Reflect.set(f.dragon.metadata, 16, 5); };
  try {
    using observation = new DragonShotObservation(f.bot, 42);
    const result = await f.end.shootDragon(new AbortController().signal, observation);
    assert.match(result.reason!, /DRAGON_PERCHED/);
    assert.equal(looks, 22);
    assert.equal(f.releases(), 0);
  } finally { clearInterval(timer); }
});

test("even the strictest shot margin yields the charged bow to dragon evasion", async () => {
  const f = fixture(), stop = new AbortController();
  const timer = setInterval(() => f.bot.emit("physicsTick"), 1);
  let danger = false, looks = 0, evasions = 0;
  Object.defineProperty(f.end, "danger", { get: () => danger });
  f.bot.look = async () => { if (++looks === 22) danger = true; };
  f.end.evade = async () => {
    evasions++;
    assert.equal(f.releases(), 0);
    stop.abort("evasion owns the body");
    return { outcome: "evaded", attacks: 0, healthBefore: null, healthAfter: null, reason: null };
  };
  try {
    using observation = new DragonShotObservation(f.bot, 42, 1.25);
    await assert.rejects(f.end.shootDragon(stop.signal, observation));
    assert.equal(evasions, 1);
    assert.equal(f.releases(), 0);
  } finally { clearInterval(timer); }
});
