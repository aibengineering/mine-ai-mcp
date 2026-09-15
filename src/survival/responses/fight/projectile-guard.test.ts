import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";

for (const permitted of [true, false]) test(`broken guard ${permitted ? "equips a spare and restarts readiness" : "respects disabled shields"}`, async () => {
  const bot = botFixture({ slots: { 45: { name: "shield" } }, items: [{ name: "shield", count: 1 }] });
  const spare = bot.inventory.items()[0]!;
  let equipped = 0, readiness = 0, activations = 0;
  bot.activateItem = () => { activations++; };
  bot.equip = async (item, destination) => {
    assert.equal(item, spare); assert.equal(destination, "off-hand");
    bot.inventory.slots[45] = spare; equipped++;
  };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    policy: { combat: { shield: permitted } }, reportDecision: () => {},
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { currentLoadout: () => ({ shield: spare }), holdFacing: async (ticks: number) => { readiness += ticks; } });
  weapons.itemUse.activateShield();
  bot.inventory.slots[45] = null;
  await weapons.maintainGuard();
  assert.equal(equipped, permitted ? 1 : 0);
  assert.equal(readiness, permitted ? 5 : 0);
  assert.equal(activations, permitted ? 2 : 1);
  assert.equal(weapons.itemUse.shieldRaised, permitted);
  await weapons.maintainGuard();
  assert.equal(equipped, permitted ? 1 : 0, "do not repeatedly equip a healthy guard");
});

test("guard aim is applied before the same tick's movement send and respects movement ownership", () => {
  const bot = botFixture();
  let phase = "guard";
  const controller = new AbortController();
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: controller.signal,
    execution: { snapshot: () => ({ phase }) }, footingRecovery: { needed: false },
    responseRequired: controller, reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { projectileDefence: () => ({ facing: new Vec3(1, 65, 0) }) });
  bot.lookAt = async () => { bot.entity.yaw = -Math.PI / 2; };
  bot.activateItem = () => {};
  weapons.itemUse.activateShield();
  bot.on("physicsTick", weapons.aimGuardBeforeMovement);
  bot.entity.yaw = 0;
  bot.emit("physicsTick");
  assert.equal(bot.entity.yaw, -Math.PI / 2, "rotation is ready before any promise continuation");
  for (phase of ["approach", "recover_footing", "release", "shoot"]) {
    bot.entity.yaw = 0;
    bot.emit("physicsTick");
    assert.equal(bot.entity.yaw, 0, `${phase} owns its own aim`);
  }
  phase = "guard";
  controller.abort();
  bot.emit("physicsTick");
  assert.equal(bot.entity.yaw, 0);
});

for (const abort of [false, true]) test(`terminal volley preserves guard after target death${abort ? " and remains cancellable" : " until the arrow clears"}`, async () => {
  const bot = botFixture({ slots: { 45: { name: "shield" } } });
  bot.activateItem = () => { bot.usingHeldItem = true; };
  bot.lookAt = async () => {};
  bot.clearControlStates = () => {};
  bot.entity.position.set(0, 64, 0);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.world.raycast = () => null;
  const arrow = { id: 9, name: "arrow", isValid: true, width: 0.5, height: 0.5,
    position: new Vec3(0, 67.3, 8), velocity: new Vec3(0, 0, -1), metadata: [] } as unknown as typeof bot.entity;
  bot.entities[9] = arrow;
  const controller = new AbortController();
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: controller.signal,
    responsiveness: { checkpoint: async () => {} },
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
    settled: () => true, footingRecovery: { needed: false },
    policy: { combat: { shield: true, critical_health: 6 } }, reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  await weapons.itemUse.raiseShield();
  let ticks = 0;
  const timer = setInterval(() => {
    assert.equal(weapons.itemUse.shieldRaised, true);
    if (++ticks === 3) {
      if (abort) controller.abort(new Error("survival takeover"));
      else arrow.isValid = false;
    }
    bot.emit("physicsTick");
  }, 2);
  try {
    if (abort) await assert.rejects(weapons.guardFinalVolley(), /survival takeover/);
    else await weapons.guardFinalVolley();
    assert.equal(ticks, 3);
    assert.equal(weapons.itemUse.shieldRaised, true, "only the normal release owns shield cleanup");
  } finally { clearInterval(timer); }
});

test("guard returns an aligned visible bow draw to shielded approach", async () => {
  const bot = botFixture();
  let ticks = 0;
  let aimed = 0;
  const decisions: unknown[] = [];
  bot.lookAt = async () => { aimed++; };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    execution: { run: async (_phase: string, effect: () => Promise<boolean>) => effect() },
    projectileGuards: 0, settled: () => false, footingRecovery: { needed: false },
    policy: { combat: { volley_wait_ticks: 100 } }, reportDecision: (event: unknown) => decisions.push(event),
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { raiseGuard: async () => {}, projectileDefence: () => ticks < 3 ? {
    imminent: false, aligned: true, windingUp: [{ id: 8 }], windupForecasts: [], projectiles: [], facing: new Vec3(0, 65, 8),
  } : null });
  const timer = setInterval(() => { ticks++; bot.emit("physicsTick"); }, 2);
  try {
    assert.equal(await weapons.guardIncoming(), true);
    assert.equal(ticks, 0, "an aligned guard can move while the bow is drawn");
    assert.equal(aimed, 1);
    assert.match(JSON.stringify(decisions), /aligned_guard_can_advance/);
  } finally { clearInterval(timer); }
});
