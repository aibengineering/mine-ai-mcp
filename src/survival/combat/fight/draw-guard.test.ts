import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, type FakeBot } from "../../../test-support/bot.js";
import { worldOf } from "../../../test-support/world.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";
import { meleeImminent } from "../../perception/combat/observations.js";

// The Cave pen of combat/creeper-navigation: a three-high stone tunnel along x
// (air at y -60 to -58, z -3 to 3) over a stone floor. Positions are the ones
// recorded in creeper2 2026-10-22T01-39-20-451Z-t00004, Cave, 12.91 s into its
// navigate: the bot at 209.3,-60,1.4 with 14 health, skeleton #24 (the
// quarry) 11.8 blocks down the tunnel and zombie #26, which had already hit
// it once, closing at about 3.5 blocks.
const air = worldOf({});
const stone = worldOf({}, { groundY: 1_000 });
const tunnel = (cell: Vec3) =>
  (cell.y >= -60 && cell.y <= -58 && cell.z >= -3 && cell.z <= 3 ? air : stone)(cell);

const mob = (id: number, name: string, position: Vec3, held: string | null) => ({
  id, name, kind: "Hostile mobs", type: "hostile", isValid: true, position, velocity: new Vec3(0, 0, 0),
  width: 0.6, height: name === "skeleton" ? 1.99 : 1.95, metadata: [], heldItem: held ? { name: held } : null,
});

function caveScene(zombieX: number) {
  const skeleton = mob(24, "skeleton", new Vec3(220.9, -60, 3.3), "bow");
  const zombie = mob(26, "zombie", new Vec3(zombieX, -60, 0.5), null);
  const bot = botFixture({
    position: new Vec3(209.3, -60, 1.39),
    blocks: tunnel,
    items: [{ name: "iron_sword", count: 1 }, { name: "bow", count: 1 }, { name: "arrow", count: 31 }],
    slots: { 45: { name: "shield", type: 0 } },
    entities: { 24: skeleton, 26: zombie },
  });
  bot.inventory.slots[45]!.type = bot.registry.itemsByName.shield!.id;
  bot.health = 14;
  const decisions: { boundary?: string; stage?: string }[] = [];
  const scene = {
    bot, target: skeleton, requestedTarget: skeleton, dead: new Set<number>(), movement: "pursue",
    position: { plan: null }, signal: new AbortController().signal, settled: () => false,
    policy: { combat: { melee: true, bow: true, shield: true } },
    perception: {
      resolvedIds: new Set<number>(), attackerIds: new Set([26]),
      read: () => [skeleton, zombie].map((entity) => ({ id: entity.id, meleeImminent: meleeImminent(bot, entity as never) })),
    },
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
    reportDecision: (event: { evidence?: { boundary?: string; stage?: string } }) => {
      if (event.evidence) decisions.push(event.evidence);
    },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  return { bot, zombie, weapons, decisions };
}

test("a sword and raised shield, not a bow draw, answer a skeleton while a zombie closes", () => {
  // Drawn here, the bow lowered the shield for twenty ticks and the zombie hit
  // the bot as the arrow left (14 to 11 health, below the pen's bar of 12).
  const { weapons } = caveScene(212.7);
  const loadout = weapons.currentLoadout();
  assert.equal(loadout.kind, "melee");
  assert.equal(loadout.weapon?.name, "iron_sword");
  assert.equal(loadout.shield?.name, "shield");

  // With the zombie beyond imminence the quarry keeps its bow, as before.
  assert.equal(caveScene(216.8).weapons.currentLoadout().kind, "bow");
});

test("a draw is cancelled, not released, once a walking attacker becomes imminent", async () => {
  const { bot, zombie, weapons, decisions } = caveScene(216.8);
  let using = false;
  bot.activateItem = () => { using = true; };
  bot.deactivateItem = () => { using = false; };
  (bot as FakeBot & { quickBarSlot: number }).quickBarSlot = 0;
  bot.setQuickBarSlot = () => { using = false; };
  Object.assign(weapons, { projectileDefence: () => null });
  const shield = weapons.currentLoadout().shield;
  assert.equal(weapons.currentLoadout().kind, "bow", "the zombie starts 7.5 blocks away");
  // A pursuing zombie closes about a quarter of a block each tick.
  const timer = setInterval(() => {
    zombie.position.x -= 0.25;
    bot.emit("physicsTick");
  }, 1);
  try {
    const shot = await weapons.shoot(shield);
    assert.equal(shot, "melee_imminent");
  } finally { clearInterval(timer); }
  const stages = decisions.filter((event) => event.boundary === "item_use").map((event) => event.stage);
  assert.ok(stages.includes("bow_draw_started"));
  assert.ok(stages.includes("bow_cancelled"), `stages: ${stages.join(", ")}`);
  assert.ok(!stages.includes("bow_released"), "no arrow leaves with the guard down");
  assert.equal(using, false);
  assert.ok(zombie.position.distanceTo(bot.entity.position) > 3, "cancelled before the zombie reached its swing");
});
