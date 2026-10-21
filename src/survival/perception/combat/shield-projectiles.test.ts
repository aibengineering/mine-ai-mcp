import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { projectileReachesBody } from "../../positioning/combat/exposure.js";
import { confirmShieldBlock, observeProjectileDefence, projectileShieldFacing, shieldFacing } from "../../weapons/shield-facing.js";
import { CombatPerception } from "./observations.js";
import { arrowImpact, arrowImpactInTicks, incomingShieldProjectiles, isIncomingArrow } from "./shield-projectiles.js";

function fixture() {
  const bot = botFixture();
  bot._client = new EventEmitter() as Bot["_client"];
  bot.entity.position.set(0, 64, 0);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.world.raycast = () => null;
  const arrow = {
    id: 8,
    name: "arrow",
    isValid: true,
    width: 0.5,
    height: 0.5,
    position: new Vec3(0, 67.3, 8),
    velocity: new Vec3(0, 0, -1),
    metadata: [],
  } as unknown as Bot["entity"];
  bot.entities[8] = arrow;
  return { bot, arrow };
}

/**
 * A player-sized bot at the origin fighting zombie #7 two blocks along +x:
 * the quarry the shield turns from, and the entity each fireball is copied from.
 */
function fireballFixture() {
  const bot = botFixture({ items: [{ name: "iron_sword", count: 1 }, { name: "shield", count: 1 }] });
  bot.entity.position.set(0, 64, 0);
  bot.world.raycast = () => null;
  const target = { id: 7, name: "zombie", isValid: true, height: 1.95, width: 0.6, position: new Vec3(2, 64, 0) } as Bot["entity"];
  bot.entities[7] = target;
  return { bot, target };
}

test("a reflected arrow inside the hit margin cannot reacquire guard", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 65, 0.4);
  arrow.velocity.set(0, 0, -1);
  assert.equal(observeProjectileDefence(bot, 0, 1000)!.heldProjectileId, arrow.id);
  arrow.velocity.set(0, 0, 0.1);
  assert.equal(isIncomingArrow(bot, arrow), false);
  confirmShieldBlock(bot);
  assert.equal(observeProjectileDefence(bot, 0, 1001), null, "confirmed contact needs no estimated grace");
});

test("contacts two ticks apart share a protective heading, including a newly observed second shot", () => {
  for (const arrivesLater of [false, true]) {
    const { bot, arrow } = fixture();
    arrow.position.set(0, 65, 1.4);
    const angle = 134 * Math.PI / 180;
    const direction = new Vec3(Math.sin(angle), 0, Math.cos(angle));
    const next = { ...arrow, id: 9, position: bot.entity.position.offset(0, 1, 0).plus(direction.scaled(3)),
      velocity: direction.scaled(-1) } as typeof arrow;
    if (arrivesLater) observeProjectileDefence(bot, 0, 1000);
    bot.entities[9] = next;
    const defence = observeProjectileDefence(bot, 0, 1001)!;
    assert.equal(defence.projectiles[0]!.impactInTicks, 1);
    assert.equal(defence.projectiles[1]!.impactInTicks, 3);
    const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0)).normalize();
    for (const shot of defence.projectiles) {
      const bearing = shot.contact.minus(bot.entity.position); bearing.y = 0;
      assert.ok(heading.dot(bearing.normalize()) >= Math.cos(70 * Math.PI / 180));
    }
  }
});

test("grazing arrow guard uses the collision bearing and retains it through estimated contact", () => {
  const { bot, arrow } = fixture();
  // Server probe attempt 15: the arrow crossed the bot's front during its
  // last movement segment. Facing its earlier position exposed the contact.
  bot.entity.position.set(2.7194334786, -60, -4.6995768174);
  arrow.position.set(3.1257581415, -58.9264723955, -3.6741039384);
  arrow.velocity.set(-1.361514457, -0.275710276, -0.629843159);
  const impact = arrowImpact(bot, arrow)!;
  assert.equal(impact.ticks, 1);
  assert.ok(impact.position.x < bot.entity.position.x, "collision is on the opposite side from the old arrow position");
  const defence = observeProjectileDefence(bot, 0, 1000)!;
  const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0));
  assert.ok(heading.x < 0 && heading.z > 0);
  assert.equal(defence.heldProjectileId, arrow.id);
  arrow.position.set(1, -60, -5); // locally predicted past the body, before confirmation
  assert.deepEqual(observeProjectileDefence(bot, 0, 1050)!.facing, defence.facing);
  assert.equal(observeProjectileDefence(bot, 0, 1200), null, "the impact window is bounded");
});

test("a new incoming arrow can replace the grace window of a shot that has passed", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 65, 2);
  const first = observeProjectileDefence(bot, 0, 1000)!;
  assert.equal(first.heldProjectileId, arrow.id);
  arrow.position.set(0, 65, -3);
  const next = { ...arrow, id: 9, position: new Vec3(0, 65, -2), velocity: new Vec3(0, 0, 1) } as typeof arrow;
  bot.entities[9] = next;
  const defence = observeProjectileDefence(bot, 0, 1050)!;
  assert.equal(defence.heldProjectileId, 9);
  assert.ok(defence.facing.z < bot.entity.position.z);
});

test("retreat and shield facing detect an arrow which falls into the body below its original ray", () => {
  const { bot, arrow } = fixture();
  assert.equal(projectileReachesBody(bot.world, arrow, bot.entity), false);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.deepEqual(incomingShieldProjectiles(bot), [arrow]);
  assert.ok(projectileShieldFacing(bot)!.z > 0);
});

test("one defensive assessment orders impacts and covers shots independently of the quarry", () => {
  const { bot, arrow } = fixture();
  bot.entity.yaw = 0;
  const side = { ...arrow, id: 9, position: new Vec3(8, 65, 0), velocity: new Vec3(-1.5, 0, 0) } as Bot["entity"];
  bot.entities[9] = side;
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles[0]!.entity.id, 9);
  assert.equal(defence.coversAll, true);
  assert.equal(defence.aligned, false);
  assert.equal(defence.imminent, true);
  assert.ok(defence.facing.x > 0 && defence.facing.z > 0);
  assert.equal(arrowImpactInTicks(bot, arrow), 8);
  assert.equal(isIncomingArrow(bot, arrow, 0, { ...bot.entity, position: new Vec3(30, 64, 0) }), false,
    "a projectile threatening the current body does not invalidate distant protected cover");
});

test("an aimed bow draw contributes defensive facing before its arrow exists", () => {
  const { bot, arrow: shooter } = fixture();
  shooter.name = "skeleton";
  shooter.kind = "Hostile mobs";
  shooter.height = 1.99;
  shooter.position.set(0, 64, 8);
  shooter.pitch = 0;
  Reflect.set(shooter, "headYaw", 0);
  Reflect.set(shooter, "heldItem", { name: "bow" });
  Reflect.set(shooter.metadata, 8, 1);
  bot.entity.yaw = -Math.PI / 2;
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles.length, 0);
  assert.deepEqual(defence.windingUp.map((entity) => entity.id), [8]);
  assert.equal(defence.aligned, false);
  assert.ok(defence.facing.z > bot.entity.position.z);
  bot.world.raycast = (() => ({ distance: 1 })) as unknown as typeof bot.world.raycast;
  assert.equal(observeProjectileDefence(bot), null, "a draw flag behind cover must not retain guard");
  bot.world.raycast = () => null;
  assert.ok(observeProjectileDefence(bot), "restored sight makes the ongoing draw a threat again");
  Reflect.set(shooter, "headYaw", Math.PI);
  assert.equal(observeProjectileDefence(bot), null, "drawing toward someone else is not our guard cue");
});

test("opposed shots admit the best achievable heading without demanding impossible coverage", () => {
  const { bot, arrow } = fixture();
  const opposite = { ...arrow, id: 9, position: new Vec3(0, 65, -8), velocity: new Vec3(0, 0, 1) } as Bot["entity"];
  bot.entities[9] = opposite;
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.coversAll, false);
  const direction = defence.facing.minus(bot.entity.position);
  bot.entity.yaw = Math.atan2(-direction.x, -direction.z);
  assert.equal(observeProjectileDefence(bot)!.aligned, true);
});

test("arrows that pass, hit terrain, or remain embedded cannot retain the retreat guard", () => {
  const { bot, arrow } = fixture();
  arrow.velocity.z = 1;
  assert.equal(isIncomingArrow(bot, arrow), false);
  arrow.velocity.z = -1;
  bot.world.raycast = () => ({}) as NonNullable<ReturnType<Bot["world"]["raycast"]>>;
  assert.equal(isIncomingArrow(bot, arrow), false);
  bot.world.raycast = () => null;
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("in_ground"), true);
  assert.equal(isIncomingArrow(bot, arrow), false, "embedded arrows can retain stale velocity");
});

test("movement allowance warns before crossing an arrow; stationary facing still prioritises an actual hit", () => {
  const { bot, arrow } = fixture();
  const miss = { ...arrow, id: 9, position: new Vec3(-2.2, 65, 2), velocity: new Vec3(0, 0, -1) } as Bot["entity"];
  bot.entities[9] = miss;
  assert.equal(isIncomingArrow(bot, miss), false);
  assert.equal(isIncomingArrow(bot, miss, 2), true);
  assert.ok(projectileShieldFacing(bot, 2)!.z > 0);
});

test("a piercing arrow cannot be answered by the shield guard", () => {
  const { bot, arrow } = fixture();
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("pierce_level"), 1);
  assert.deepEqual(incomingShieldProjectiles(bot), []);
});

test("a vertical arrow with a zero-speed apex still falls into the body", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 67, 0);
  arrow.velocity.set(0, 0.05 / 0.99, 0);
  bot.world.raycast = (_origin, direction) => {
    assert.ok(Number.isFinite(direction.x) && Number.isFinite(direction.y) && Number.isFinite(direction.z));
    return null;
  };
  assert.equal(isIncomingArrow(bot, arrow), true);
});

test("perception retains native arrow spawn velocity for immediate guarding and releases its listeners", () => {
  const { bot, arrow } = fixture();
  arrow.velocity.set(0, 0, 0);
  const before = bot._client.listenerCount("spawn_entity");
  const perception = new CombatPerception(bot);
  assert.equal(isIncomingArrow(bot, arrow), false);
  bot._client.emit("spawn_entity", {
    entityId: arrow.id,
    type: bot.registry.entitiesByName.arrow!.id,
    objectData: 123,
    velocity: { x: 0, y: 0, z: -8000 },
  });
  assert.equal(arrow.velocity.z, -1);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.equal(perception.attackerIds.size, 0, "do not guess an arrow owner from an unverified packet field");
  perception[Symbol.dispose]();
  assert.equal(bot._client.listenerCount("spawn_entity"), before);
});

test("the shield faces the nearer incoming fireball instead of the first spawned one", () => {
  const fixture = fireballFixture();
  const far = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    position: new Vec3(20, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  const near = Object.assign({}, far, {
    id: 9,
    position: new Vec3(-4, 65, 0),
    velocity: new Vec3(0.5, 0, 0),
  });
  fixture.bot.entities[8] = far;
  fixture.bot.entities[9] = near;
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x < 0);
  near.velocity.set(0.04, 0, 0);
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x > 0, "the farther but faster shot arrives first");
  near.velocity.set(-0.5, 0, 0);
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x > 0, "ignore an outgoing shot");
});

test("a newly spawned closer fireball does not turn the shield away from the faster arriving shot", () => {
  const fixture = fireballFixture();
  fixture.bot.entity.position.set(-38.51882905638842, 84, 349.4525623707544);
  // EyesBot's last crossfire before the native hit at 1788827792555.
  // Packet positions lag: the older shot was already travelling much faster.
  const fast = Object.assign({}, fixture.target, {
    id: 267,
    name: "small_fireball",
    position: new Vec3(-39.24482423067093, 84.46190628434644, 364.6435395723108),
    velocity: new Vec3(0.0085, 0.044125, -0.821),
  });
  const fresh = Object.assign({}, fast, {
    id: 269,
    position: new Vec3(-29.8190077044475, 87.43404808815258, 346.838228020483),
    velocity: new Vec3(-0.09325, -0.021, 0.029),
  });
  fixture.bot.entities[267] = fast;
  fixture.bot.entities[269] = fresh;
  assert.equal(incomingShieldProjectiles(fixture.bot)[0], fast);
  const heading = shieldFacing(fixture.bot, fixture.target, new Set()).minus(fixture.bot.entity.position);
  heading.y = 0;
  heading.normalize();
  for (const shot of [fast, fresh]) {
    const toward = shot.position.minus(fixture.bot.entity.position);
    toward.y = 0;
    assert.ok(
      heading.dot(toward.normalize()) >= Math.cos((70 * Math.PI) / 180),
      "both observed bearings fit one guard",
    );
  }
});

test("a retreat warning includes a crossing shot before it intersects the stationary body", () => {
  const fixture = fireballFixture();
  const shot = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    position: new Vec3(-2.313, 65.6144, 8.0195),
    velocity: new Vec3(0.5174, -0.0818, -1.1401),
  });
  fixture.bot.entities[8] = shot;
  assert.equal(incomingShieldProjectiles(fixture.bot)[0], undefined, "the observed ray currently misses the body");
  assert.equal(incomingShieldProjectiles(fixture.bot, 2)[0], shot, "movement needs time to stop and ready the shield");
  shot.velocity = shot.velocity.scaled(-1);
  assert.equal(incomingShieldProjectiles(fixture.bot, 2)[0], undefined, "outgoing shots do not retain the guard");
});
test("a walking guard counts a close draw as covered only where its arrow will enter the body", () => {
  // Elevated in r3-c 2026-10-21T05-00-53-619Z (t00011), 196 ms before an
  // unblocked arrow: the bot walks west at 0.08 blocks/tick, guarded, facing
  // west along its route; skeleton #10 draws 3.7 blocks to the north-west.
  // Vanilla 1.21.4 blocks when the arrow's entry point on the bot's box
  // (inflated by 0.3) lies in front of the head yaw the server held on the
  // tick before the hit. The arrow aims at where the bot stands at release
  // and lands two or three ticks later, by when the walk has carried the box
  // west, so it enters the north face east of the centre: 90 degrees from a
  // westward yaw. The shooter's own bearing, 58 degrees off, looked covered.
  const { bot } = fixture();
  delete bot.entities[8];
  bot.entity.position.set(209.2431, -60, -13.4401);
  bot.entity.velocity.set(-0.0824, -0.0784, -0.0106);
  bot.entity.yaw = 1.482;
  bot.entities[10] = {
    id: 10, name: "skeleton", kind: "Hostile mobs", isValid: true, height: 1.99, width: 0.6,
    position: new Vec3(207.7681, -60, -16.8118), velocity: new Vec3(0, 0, 0),
    heldItem: { name: "bow" }, metadata: { 8: 1 }, headYaw: 3.5834, pitch: 0,
  } as unknown as Bot["entity"];
  const walking = observeProjectileDefence(bot)!;
  assert.deepEqual(walking.windingUp.map((entity) => entity.id), [10]);
  assert.equal(walking.aligned, false, "the route's heading leaves the entry point unguarded");

  // Standing, the same draw enters on the shooter's bearing and the same
  // heading still covers it.
  bot.entity.velocity.set(0, -0.0784, 0);
  assert.equal(observeProjectileDefence(bot)!.aligned, true);
});
