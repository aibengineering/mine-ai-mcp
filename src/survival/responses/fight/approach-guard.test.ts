import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { flatWorld } from "../../../test-support/navigation.js";
import { FightMovement } from "./movement.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";

type Entity = Bot["entity"];
const GUARD_YAW = -2.2698;
const ROUTE_YAW = 1.597;

/**
 * skeleton-arena-crossfire, xfire-base 2026-10-22T02-15-15-576Z (t00002), the
 * last 150 ms before an unblocked arrow. The bot fights skeleton #5, 3.4
 * blocks to the south, behind a raised shield turned toward its draw. An
 * approach starts with the draw two ticks from release, and its route turns
 * the body 140 degrees, toward the west, before the next tick.
 */
function arenaScene() {
  const skeleton = {
    id: 5, name: "skeleton", kind: "Hostile mobs", type: "hostile", isValid: true, width: 0.6, height: 1.99,
    position: new Vec3(-2.1089, -60, 7.7), velocity: new Vec3(0, 0, 0),
    heldItem: { name: "bow" }, metadata: { 8: 1 }, headYaw: 6.0132, pitch: 0,
  } as unknown as Entity;
  const bot = botFixture({ position: new Vec3(-1.1043, -60, 4.4628), groundY: -61, entities: { 5: skeleton } });
  bot.entity.yaw = GUARD_YAW;
  bot.entity.velocity.set(-0.0291, -0.0784, 0.0027);
  bot.activateItem = () => { bot.usingHeldItem = true; };
  // Mineflayer applies a forced look synchronously and sends it with the
  // movement packet that follows the physicsTick listeners.
  bot.lookAt = (async (point: Vec3) => {
    bot.entity.yaw = Math.atan2(-(point.x - bot.entity.position.x), -(point.z - bot.entity.position.z));
  }) as Bot["lookAt"];
  let route: { stop: AbortSignal; settle: () => void } | null = null;
  const navigation = {
    world: flatWorld(),
    onEvent: () => () => {},
    navigate: async (options: { stopSignal: AbortSignal }) => {
      // The route's first step faces along it before the next tick.
      bot.entity.yaw = ROUTE_YAW;
      return await new Promise((resolve) => {
        const settle = () => resolve({ status: "stopped", reason: String(options.stopSignal.reason), elapsedMs: 0 });
        route = { stop: options.stopSignal, settle };
        options.stopSignal.addEventListener("abort", settle);
      });
    },
  };
  const decisions: { boundary?: string; stage?: string }[] = [];
  const controller = new AbortController();
  const scene = {
    bot, target: skeleton, requestedTarget: skeleton, dead: new Set<number>(), movement: "pursue",
    position: { plan: null }, signal: controller.signal, responseRequired: controller, settled: () => false,
    footingRecovery: { needed: false }, navigation,
    policy: { combat: { melee: true, bow: false, shield: true, terrain: { dig: false, place: false } } },
    perception: { resolvedIds: new Set<number>(), attackerIds: new Set<number>(), read: () => [] },
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
    reportDecision: (event: { evidence?: { boundary?: string; stage?: string } }) => {
      if (event.evidence) decisions.push(event.evidence);
    },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, {
    currentLoadout: () => ({ kind: "melee", shield: { name: "shield" } }),
    raiseGuard: async () => {},
    contact: () => null,
  });
  weapons.itemUse.activateShield();
  const movement = new FightMovement(scene, weapons);
  return { bot, movement, decisions, route: () => route };
}

test("an approach stopped for an arrow sends the guard's facing on that tick, not the route's", async () => {
  const { bot, movement, decisions, route } = arenaScene();
  const approach = movement.approach(true, null);
  while (!route()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.entity.yaw, ROUTE_YAW, "the route has turned the body");

  // The draw is released: arrow #25 lands in two ticks, on the body's south
  // face, 96 degrees off the route's facing.
  bot.entities[25] = {
    id: 25, name: "arrow", isValid: true, width: 0.5, height: 0.5, metadata: [],
    position: new Vec3(-2.2883, -58.36, 7.7), velocity: new Vec3(0.627, -0.2148, -1.4466),
  } as unknown as Entity;
  bot.entity.position.set(-1.2314, -60, 4.4654);
  bot.entity.velocity.set(-0.0694, -0.0784, 0.0014);
  bot.emit("physicsTick");
  // Mineflayer sends this tick's movement packet now. The server blocks with
  // the head yaw it held on the tick before the hit, two ticks away.
  const facing = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const toward = new Vec3(-2.2883, 0, 7.7).minus(new Vec3(-1.2314, 0, 4.4654)).normalize();
  assert.ok(facing.dot(toward) >= Math.cos((70 * Math.PI) / 180),
    `the yaw sent this tick (${bot.entity.yaw.toFixed(2)}) covers the arrow`);
  assert.ok(decisions.some((event) => event.stage === "stop_requested"));
  assert.equal(await approach, null);
});
