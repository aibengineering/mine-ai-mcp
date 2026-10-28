import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { botFixture } from "../../../test-support/bot.js";
import { TestEndCore } from "../../../test-support/combat.js";
import { physicsEveryMillisecond } from "../../../test-support/physics.js";
import { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import type { FootingRecovery } from "../../responses/footing.js";
import { DragonShot } from "./dragon-shot.js";

// A full bow draw is 20 ticks; a test that needs the world to change while an
// arrow is charged waits that long with the bow up, rather than counting the
// aim loop's head turns.
const FULL_DRAW_TICKS = 20;

function fixture() {
  let drawing = false, drawnTicks = 0, releases = 0;
  const dragon = { id: 42, name: "ender_dragon", isValid: true, position: new Vec3(30, 84, 0),
    velocity: new Vec3(0, 0, 0), yaw: 0, metadata: { 9: 190, 16: 1 } } as unknown as Bot["entity"];
  const bot = botFixture({ dimension: "the_end", groundY: 63, entities: { 42: dragon },
    items: [{ name: "bow", count: 1 }, { name: "arrow", count: 3 }] }, {
    clearControlStates() {}, setQuickBarSlot() { drawing = false; },
    activateItem() { drawing = true; }, deactivateItem() { if (drawing) releases++; drawing = false; },
  });
  // The shot runs against the shared core, so a test can stub its danger and escape.
  const end = new TestEndCore(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  const shot = new DragonShot(end);
  // Server ticks, counting those that pass with the bow drawn.
  const physics = () => physicsEveryMillisecond(bot, () => { drawnTicks = drawing ? drawnTicks + 1 : 0; });
  return { bot, dragon, end, shot, physics, releases: () => releases, charged: () => drawnTicks >= FULL_DRAW_TICKS };
}

test("shoot_dragon refuses absent arrows and arrow-immune perches without releasing", async () => {
  const f = fixture();
  using _physics = f.physics();
  f.bot.inventory.items().pop();
  using missing = new DragonShotObservation(f.bot, 42);
  assert.equal((await f.shot.shootDragon(new AbortController().signal, missing)).outcome, "weapon_unavailable");
  f.bot.inventory.items().push({ name: "arrow", count: 1 } as never);
  Reflect.set(f.dragon.metadata, 16, 5);
  using perched = new DragonShotObservation(f.bot, 42);
  assert.match((await f.shot.shootDragon(new AbortController().signal, perched)).reason!, /DRAGON_PERCHED/);
  assert.equal(f.releases(), 0);
});

test("caller cancellation during the draw does not release an arrow", async () => {
  const f = fixture(), stop = new AbortController();
  f.bot.activateItem = () => { stop.abort("cancelled while drawing"); };
  using _physics = f.physics();
  using observation = new DragonShotObservation(f.bot, 42);
  await assert.rejects(f.shot.shootDragon(stop.signal, observation));
  assert.equal(observation.attacks, 0);
  assert.equal(f.releases(), 0);
});

test("a released arrow without health loss is a miss and is not retried", async () => {
  const f = fixture();
  using _physics = f.physics();
  using observation = new DragonShotObservation(f.bot, 42);
  const result = await f.shot.shootDragon(new AbortController().signal, observation);
  assert.equal(result.outcome, "shot_missed");
  assert.equal(result.attacks, 1);
  assert.equal(f.releases(), 1);
  assert.equal(observation.damageObserved, 0);
});

// The perch lands while the bot turns its head with a charged arrow: the
// revalidation after each aim, not only the check before it, must hold fire.
test("a perch update during the final aim cancels the charged arrow", async () => {
  const f = fixture();
  using _physics = f.physics();
  let perchedWhileCharged = false;
  f.bot.look = async () => {
    if (!f.charged() || perchedWhileCharged) return;
    perchedWhileCharged = true;
    Reflect.set(f.dragon.metadata, 16, 5);
  };
  using observation = new DragonShotObservation(f.bot, 42);
  const result = await f.shot.shootDragon(new AbortController().signal, observation);
  assert.match(result.reason!, /DRAGON_PERCHED/);
  assert.ok(perchedWhileCharged);
  assert.equal(f.releases(), 0);
});

test("even the strictest shot margin yields the charged bow to dragon evasion", async () => {
  const f = fixture(), stop = new AbortController();
  using _physics = f.physics();
  let danger = false, evasions = 0;
  Object.defineProperty(f.end, "danger", { get: () => danger });
  f.bot.look = async () => { if (f.charged()) danger = true; };
  f.end.evade = async () => {
    evasions++;
    assert.equal(f.releases(), 0);
    stop.abort("evasion owns the body");
    return { outcome: "evaded", attacks: 0, healthBefore: null, healthAfter: null, reason: null };
  };
  using observation = new DragonShotObservation(f.bot, 42, 1.25);
  await assert.rejects(f.shot.shootDragon(stop.signal, observation));
  assert.ok(danger);
  assert.equal(evasions, 1);
  assert.equal(f.releases(), 0);
});
