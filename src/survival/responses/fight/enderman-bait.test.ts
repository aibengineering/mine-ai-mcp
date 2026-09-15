import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { botFixture } from "../../../test-support/bot.js";
import { EndermanFight } from "./enderman.js";
import type { FightScene } from "./scene.js";
import type { FightMovement } from "./movement.js";
import { FightWeapons } from "./weapons.js";
import { selectMeleeLoadout } from "../../weapons/equipment.js";

for (const terrain of ["level", "late", "stationary", "gap", "blocked", "hold", "unshielded", "cancel", "knockback"] as const)
  test(`roof bait returns to the centre and respects ${terrain}`, async () => {
    const bot = botFixture();
    bot.entity.position.set(0.5, 0, 0.5);
    bot.entity.onGround = true;
    bot.entity.yaw = 0;
    const world = new MemoryWorld();
    for (let x = -1; x <= 5; x++)
      for (let y = -1; y <= 2; y++) world.load({ x, y, z: 0 }, { stateId: y === -1 ? 1 : 0 });
    if (terrain === "gap") world.load({ x: 1, y: -1, z: 0 }, { stateId: 0 });
    if (terrain === "blocked") world.load({ x: 1, y: 0, z: 0 }, { stateId: 1 });
    let controller = new AbortController();
    const controls = { forward: false, back: false, left: false, right: false };
    bot.setControlState = (key, value) => { if (key in controls) Reflect.set(controls, key, value); };
    let stopped = 0, resumed = 0, maximumX = 0.5, ticks = 0;
    const scene = { bot, target: { id: 7, position: new Vec3(10, 0, 0.5), width: 0.6, height: 2.9 },
      targetId: 7, movement: terrain === "hold" ? "hold" : "pursue", navigation: { world },
      signal: controller.signal, settled: () => false,
      elapsedTicks: 20, position: { hasHeightProtection: () => true, at: () => bot.entity.position.distanceTo(new Vec3(0.5, 0, 0.5)) < 0.2 },
      execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() }, reportDecision: () => {},
    } as unknown as FightScene;
    Reflect.set(scene, "requestedTarget", scene.target);
    const weapons = { contact: () => null, maintainGuard: async () => {}, currentLoadout: () => ({ shield: terrain === "unshielded" ? null : {} }), raiseGuard: async () => {}, faceGuard: async () => {} } as unknown as FightWeapons;
    const movement = { footing: { stop: async () => { stopped++; }, start: () => { resumed++; } },
      positionEffect: async (effect: (signal: AbortSignal) => Promise<void>) => ({ kind: "completed", value: await effect(controller.signal) }),
    } as unknown as FightMovement;
    const fight = new EndermanFight(scene, weapons, movement);
    const budget = { remaining: 290, [Symbol.dispose]() {} };
    fight.state = { kind: "committed", cell: new Vec3(0, 0, 0), hits: 0,
      budget: budget as never };
    const timer = setInterval(() => {
      bot.entity.position.x += (Number(controls.right) - Number(controls.left)) * 0.1;
      scene.elapsedTicks++;
      if (terrain !== "stationary" && bot.entity.position.x > (terrain === "late" ? 3 : 2))
        scene.target.position.z = 1;
      maximumX = Math.max(maximumX, bot.entity.position.x);
      if (++ticks === 3 && (terrain === "cancel" || terrain === "knockback")) controller.abort(new Error("takeover"));
      bot.emit("physicsTick");
    }, 1);
    try {
      if ((terrain === "cancel" || terrain === "knockback")) await assert.rejects(fight.baitRoof(), /takeover/);
      else await fight.baitRoof();
      assert.equal(stopped, ["level", "late", "stationary", "unshielded", "cancel", "knockback"].includes(terrain) ? 1 : 0);
      assert.equal(resumed, stopped);
      assert.deepEqual(controls, { forward: false, back: false, left: false, right: false });
      if (["level", "late", "stationary", "unshielded"].includes(terrain)) {
        assert.ok(maximumX > 2, "leave the old 0.8-block jitter and reach beyond the eave");
        if (terrain === "late") assert.ok(maximumX > 3 && maximumX < 3.3, "observed motion reverses the walk");
        if (terrain === "stationary") assert.ok(maximumX <= 4.6, "an unresponsive quarry cannot cause an unbounded chase");
        if (terrain === "level" || terrain === "unshielded") assert.ok(maximumX < 2.3, "return as soon as the quarry moves");
        assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 0, 0.5)) < 0.2);
      }
      if ((terrain === "cancel" || terrain === "knockback")) {
        controller = new AbortController();
        if (terrain === "knockback") bot.entity.position.x = 5.5;
        await fight.maintain();
        if (terrain === "knockback") {
          assert.equal(bot.entity.position.x, 5.5, "do not steer across terrain outside the saved return corridor");
          assert.equal(fight.state.kind, "unprepared");
        } else assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 0, 0.5)) < 0.2, "resume the saved return after a tactical interruption");
        assert.equal(resumed, 2);
      }
      assert.equal(budget.remaining, 290, "bait does not renew confirmed-hit progress");
    } finally { clearInterval(timer); }
  });

test("a shielded lure lands ready shared strikes before returning home without waiting out cooldowns", async () => {
  const bot = botFixture({ items: [{ name: "iron_sword", count: 1 }, { name: "shield", count: 1 }],
    slots: { 45: { name: "shield" } } });
  bot.entity.position.set(0.5, 0, 0.5);
  const target = { id: 7, name: "enderman", isValid: true, position: new Vec3(10, 0, 0.5), width: 0.6, height: 2.9 } as BotTarget;
  bot.entities[7] = target;
  const world = new MemoryWorld();
  for (let x = -1; x <= 5; x++) for (let y = -1; y <= 2; y++)
    world.load({ x, y, z: 0 }, { stateId: y === -1 ? 1 : 0 });
  const controls = { forward: false, back: false, left: false, right: false };
  bot.setControlState = (key, value) => { if (key in controls) Reflect.set(controls, key, value); };
  bot.activateItem = () => { bot.usingHeldItem = true; };
  const hits: { x: number; tick: number; guarded: boolean }[] = [];
  const scene = { bot, target, requestedTarget: target, targetId: 7, movement: "pursue", navigation: { world },
    signal: new AbortController().signal, settled: () => false, roofTargetHostile: () => true,
    elapsedTicks: 20, attacks: 0, stylesUsed: new Set(), weaponsUsed: new Set(), dead: new Set(),
    policy: { combat: { melee: true, shield: true } }, perception: { read: () => [] },
    position: { hasHeightProtection: () => true, at: () => bot.entity.position.x < 0.7 },
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() }, reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const loadout = selectMeleeLoadout(bot.inventory.items());
  bot.heldItem = loadout.weapon;
  Reflect.set(weapons, "currentLoadout", () => loadout);
  // The lure starts with a readied guard, as its admission normally establishes.
  weapons.itemUse.activateShield();
  bot.attack = () => hits.push({ x: bot.entity.position.x, tick: scene.elapsedTicks, guarded: bot.usingHeldItem });
  const movement = { footing: { stop: async () => {}, start: () => {} },
    positionEffect: async (effect: (signal: AbortSignal) => Promise<void>) => ({ kind: "completed", value: await effect(scene.signal) }),
  } as unknown as FightMovement;
  const fight = new EndermanFight(scene, weapons, movement);
  fight.state = { kind: "committed", cell: new Vec3(0, 0, 0), hits: 0, budget: { remaining: 290 } as never };
  const timer = setInterval(() => {
    bot.entity.position.x += (Number(controls.right) - Number(controls.left)) * 0.1;
    if (bot.entity.position.x > 2) target.position.x = 3.5;
    scene.elapsedTicks++;
    bot.emit("physicsTick");
  }, 1);
  try {
    await fight.baitRoof();
    assert.ok(hits.length > 0);
    assert.ok(hits[0]!.x > 1.5, "take the opening outside the centre, before retreat completes");
    assert.ok(hits.every((hit) => hit.guarded), "a moving sword hit must not lower the shield");
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.tick - hits[i - 1]!.tick >= loadout.cooldownTicks);
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 0, 0.5)) < 0.2);
    assert.equal(scene.attacks, hits.length);
    scene.elapsedTicks += loadout.cooldownTicks;
    bot.heldItem = null;
    assert.equal(weapons.strike(target, loadout), false, "a newly selected loadout is not proof that it is equipped");
    assert.equal(scene.attacks, hits.length);
  } finally { clearInterval(timer); }
});

type BotTarget = FightScene["target"];
