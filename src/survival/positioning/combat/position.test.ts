import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { shieldCoverage } from "../../weapons/shield-facing.js";
import { decideCombatPosition, positionExposed, projectileReachesBody, type PositionThreat } from "./exposure.js";
import { clearPlannedRay, positionWorld, standingBody } from "./geometry.js";
import { endermanRoof, roofLurePath, roofEngagementAvailable, findCombatPosition, findRoofPosition } from "./planner.js";

function arena() {
  const world = new MemoryWorld();
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++)
      for (let y = -1; y <= 8; y++) world.load({ x, y, z }, { stateId: y === -1 ? 1 : 0 });
  return world;
}
const shooter: PositionThreat = {
  id: 1,
  position: new Vec3(0.5, 0, -8),
  width: 0.6,
  height: 1.8,
  attack: "projectile",
};

test("a future roof eave does not obstruct provocation before construction", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  const target = new Vec3(7.5, 2, 0.5);
  const opening = { kind: "provoke", targetEye: target.offset(0, 2.55, 0), eyeHeight: 1.62 } as const;
  assert.equal(clearPlannedRay(world, [], origin.offset(0.5, 1.62, 0.5), opening.targetEye), true);
  assert.equal(clearPlannedRay(world, endermanRoof(origin), origin.offset(0.5, 1.62, 0.5), opening.targetEye), false);
  const { plan } = findRoofPosition(world, origin, target, 11, () => true, opening);
  assert.ok(plan);
  assert.ok(plan.cell.equals(origin));
  assert.equal(clearPlannedRay(world, plan.placements, plan.cell.offset(0.5, 1.62, 0.5), opening.targetEye), false);
});

test("an existing roof with a reachable gaze opening is reused without new materials", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  for (const cell of endermanRoof(origin)) world.load(cell, { stateId: 1 });
  const target = new Vec3(7.5, 1, 0.5);
  const opening = { kind: "provoke", targetEye: target.offset(0, 2.55, 0), eyeHeight: 1.62 } as const;
  const { plan } = findRoofPosition(world, origin, target, 32, () => true, opening);
  assert.ok(plan);
  assert.ok(plan.cell.equals(origin));
  assert.equal(plan.placements.length, 0);
  assert.ok(roofLurePath(world, origin, target).some((at) => clearPlannedRay(world, [], at.offset(0.5, 1.62, 0.5), opening.targetEye)));
  assert.ok(findRoofPosition(world, origin, target, 0, () => true, opening).plan);
  assert.ok(findRoofPosition(world, origin, target, 0, () => true, { kind: "protection" }).plan);
  assert.equal(clearPlannedRay(new MemoryWorld(), [], origin.offset(0.5, 1.62, 0.5), opening.targetEye), false);
});

test("navigation can evaluate a roof above the local layer without weakening gaze or material checks", () => {
  const world = arena();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) world.load({ x, y: 2, z }, { stateId: 1 });
  const origin = new Vec3(0, 0, 0);
  const above = new Vec3(8, 3, 0);
  const target = new Vec3(11.5, 3, 8.5);
  const opening = { kind: "provoke", targetEye: target.offset(0, 2.55, 0), eyeHeight: 1.62 } as const;
  assert.equal(findRoofPosition(world, origin, target, 64, () => true, opening).plan, null);
  const found = findRoofPosition(world, above, target, 64, () => true, opening, [above]).plan;
  assert.ok(found?.cell.equals(above));
  assert.equal(findRoofPosition(world, above, target, 0, () => true, opening, [above]).plan, null);
  assert.equal(findRoofPosition(world, above, target, 64, () => false, opening, [above]).plan, null);
});

test("navigation can evaluate cover on an upper platform instead of rejecting the entire local layer", () => {
  const world = arena();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) world.load({ x, y: 2, z }, { stateId: 1 });
  const origin = new Vec3(0, 0, 0);
  const above = new Vec3(8, 3, 0);
  const threat = { ...shooter, position: new Vec3(8.5, 5, -8) };
  assert.equal(findCombatPosition(world, origin, [threat], threat, 64), null);
  assert.ok(findCombatPosition(world, above, [threat], threat, 64, [above]));
  const unsupported = above.offset(0, 1, 0);
  assert.equal(findCombatPosition(world, unsupported, [threat], threat, 64, [unsupported]), null);
});

test("a replacement enderman roof permits a reversible bait approach and excludes unproductive positions", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  const target = { ...shooter, position: new Vec3(7.5, 0, 0.5), height: 2.9, attack: "melee" as const };
  const unproductive = new Set<string>();
  const opening = { kind: "engage" as const, target, eyeHeight: 1.62, unproductive };
  assert.ok(findRoofPosition(world, origin, target.position, 64, () => true, opening, [origin]).plan);
  const close = new Vec3(5, 0, 0);
  assert.ok(findRoofPosition(world, close, target.position, 64, () => true, opening, [close]).plan);
  unproductive.add(`${close}:${target.position.floored()}`);
  assert.equal(findRoofPosition(world, close, target.position, 64, () => true, opening, [close]).plan, null);
});

test("a roof puts its support column behind the opening toward the enderman", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const target = origin.offset(0.5, 0, 0.5).plus(side.scaled(7));
    const { plan } = findRoofPosition(world, origin, target, 11, () => true, { kind: "protection" });
    assert.ok(plan);
    assert.ok(plan.cell.equals(origin));
    assert.ok(plan.placements.some((cell) => cell.equals(origin.minus(side))));
    assert.ok(!plan.placements.some((cell) => cell.y < 2 && cell.equals(origin.plus(side))));
  }
});

test("roof admission excludes occupied shell cells before choosing its cheapest home", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  const clear = (cell: Vec3) => !cell.equals(origin.offset(0, 2, 0));
  const { plan } = findRoofPosition(world, origin, shooter.position, 11, clear, { kind: "protection" });
  assert.ok(plan);
  assert.ok(!plan.cell.equals(origin));
  assert.ok(plan.placements.every(clear));
  assert.equal(findRoofPosition(world, origin, shooter.position, 11, () => false, { kind: "protection" }).plan, null);
});

test("a raised roof budgets its missing foundation instead of admitting an unbuildable column", () => {
  const world = arena();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 1 });
  const origin = new Vec3(0, 1, 0);
  assert.equal(findRoofPosition(world, origin, shooter.position, 11, () => true, { kind: "protection" }).plan, null);
  const { plan } = findRoofPosition(world, origin, shooter.position, 12, () => true, { kind: "protection" });
  assert.ok(plan);
  const overhead = plan.placements.filter((cell) => cell.y === origin.y + 2);
  assert.equal(overhead.length, 9, "all nine overhead cells are budgeted, including the eave");
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++) assert.ok(overhead.some((cell) => cell.equals(origin.offset(x, 2, z))));
  assert.ok(
    plan.placements.some((cell) => cell.y === 0),
    "the column attaches beside the existing floor",
  );
  for (const cell of plan.placements) world.load(cell, { stateId: 1 });
  assert.equal(
    findRoofPosition(world, origin, shooter.position, 0, () => false, { kind: "protection" }).plan?.placements.length,
    0,
    "reuse the observed completed roof without requiring another placement",
  );
});

test("one overhead block does not qualify as a completed enderman roof", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  world.load(origin.offset(0, 2, 0), { stateId: 1 });
  assert.equal(findRoofPosition(world, origin, shooter.position, 0, () => true, { kind: "protection" }).plan, null);
});

test("a natural two-high alcove supplies protection without a nine-block ceiling", () => {
  const world = arena();
  const home = new Vec3(0, 0, 0);
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (x >= 0 && z === 0) world.load({ x, y: 2, z }, { stateId: 1 });
    else for (let y = 0; y <= 1; y++) world.load({ x, y, z }, { stateId: 1 });
  }
  const target = new Vec3(7.5, 0, 0.5);
  const plan = findRoofPosition(world, new Vec3(2, 0, 0), target, 0, () => false, { kind: "protection" }).plan;
  assert.ok(plan);
  assert.ok(plan.cell.equals(home));
  assert.equal(plan.placements.length, 0);
  assert.ok(roofLurePath(world, home, target).some((at) => at.x >= 2), "the existing doorway permits a lure and return");
  world.load({ x: -1, y: 1, z: 0 }, { stateId: 0 });
  assert.equal(findRoofPosition(world, home, target, 0, () => false, { kind: "protection" }, [home]).plan, null,
    "a missing wall cannot be assumed to exclude the mob");
});

test("a partial roof supplies placement support without another scaffold column", () => {
  const world = arena();
  const home = new Vec3(0, 0, 0);
  world.load(home.offset(0, 2, 0), { stateId: 1 });
  const plan = findRoofPosition(world, home, new Vec3(7, 0, 0), 8, () => true, { kind: "protection" }, [home]).plan;
  assert.ok(plan);
  assert.equal(plan.placements.length, 8);
  assert.ok(plan.placements.every((at) => at.y === 2));
});

test("incoming fire includes vanilla's inflated hitbox at the upper shoulder", () => {
  const projectile = {
    position: new Vec3(10, 2.05, 0.55),
    velocity: new Vec3(-1, 0, 0),
    width: 0.3125,
    height: 0.3125,
  };
  const body = { position: new Vec3(0, 0, 0), width: 0.6, height: 1.8 };
  assert.equal(projectileReachesBody({ raycast: () => null }, projectile, body), true);
  assert.equal(
    projectileReachesBody({ raycast: () => null }, { ...projectile, position: new Vec3(10, 2.2, 0.55) }, body),
    false,
  );
});

test("a constructed refuge avoids the surveyed partial railing without replacing it", () => {
  const world = arena();
  for (let x = -2; x <= 2; x++) {
    world.load({ x, y: 0, z: -1 }, { stateId: 1 });
    world.load(
      { x, y: 1, z: -1 },
      { stateId: 2, collisionShapes: [{ minX: 0.375, minY: 0, minZ: 0.375, maxX: 0.625, maxY: 1.5, maxZ: 0.625 }] },
    );
  }
  world.load({ x: 0, y: 0, z: 2 }, { stateId: 1 });
  const threats = [
    { ...shooter, position: new Vec3(-2.5, 3, 0.5) },
    { ...shooter, id: 2, position: new Vec3(2.5, 3, 4.5) },
  ];
  const plan = findCombatPosition(world, new Vec3(0, 0, 0), threats, threats[0]!, 64);
  assert.ok(plan);
  assert.equal(
    plan.placements.some((cell) => cell.z === -1),
    false,
    "never try replacing the existing railing",
  );
});

test("a fireball blocked by a wall must not keep the protected bot guarding", () => {
  const world = arena();
  const projectile = { position: new Vec3(0.5, 0.9, -5), velocity: new Vec3(0, 0, 0.5), width: 0.3125, height: 0.3125 };
  const body = standingBody(new Vec3(0, 0, 0));
  assert.equal(projectileReachesBody(positionWorld(world), projectile, body), true);
  world.load({ x: 0, y: 0, z: -2 }, { stateId: 1 });
  assert.equal(projectileReachesBody(positionWorld(world), projectile, body), false);
});

test("a low wall does not protect the head; full cover stops the firing line", () => {
  const world = arena();
  const body = standingBody(new Vec3(0, 0, 0));
  world.load({ x: 0, y: 0, z: -2 }, { stateId: 1 });
  assert.equal(positionExposed(positionWorld(world), body, shooter), true);
  world.load({ x: 0, y: 1, z: -2 }, { stateId: 1 });
  assert.equal(positionExposed(positionWorld(world), body, shooter), false);
});

test("construction preserves the doorway and prefers the resulting terrain on the next engagement", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  const plan = findCombatPosition(world, origin, [shooter], shooter, 64);
  assert.ok(plan);
  assert.ok(plan.placements.length > 0);
  for (const cell of plan.placements) {
    assert.equal(
      [plan.protected, plan.fighting, plan.entrance].some(
        (body) => cell.x === body.x && cell.z === body.z && cell.y < body.y + 2,
      ),
      false,
    );
    world.load(cell, { stateId: 1 });
  }
  assert.equal(positionExposed(positionWorld(world), standingBody(plan.protected), shooter), false);
  const reused = findCombatPosition(world, origin, [shooter], shooter, 0);
  assert.ok(reused);
  assert.equal(reused.placements.length, 0);
});

test("a mob entering protection invalidates it even when the ranged firing line is blocked", () => {
  const world = arena();
  const plan = findCombatPosition(world, new Vec3(0, 0, 0), [shooter], shooter, 64)!;
  for (const cell of plan.placements) world.load(cell, { stateId: 1 });
  const intruder: PositionThreat = { ...shooter, id: 2, attack: "melee", position: plan.fighting.offset(0.5, 0, 0.5) };
  assert.equal(positionExposed(positionWorld(world), standingBody(plan.protected), intruder), true);
  assert.equal(
    decideCombatPosition({
      protected: false,
      atProtection: true,
      hurt: true,
      canAttack: true,
      canDefendHere: false,
      attackExposed: false,
    }),
    "establish",
  );
});

test("hurt and incoming crossfire return through the same decision, and unknown attack modes establish no protection", () => {
  const facts = {
    protected: true,
    atProtection: false,
    hurt: false,
    canAttack: true,
    canDefendHere: false,
    attackExposed: false,
  };
  assert.equal(decideCombatPosition(facts), "attack");
  assert.equal(decideCombatPosition({ ...facts, hurt: true }), "return");
  assert.equal(decideCombatPosition({ ...facts, attackExposed: true }), "return");
  assert.equal(decideCombatPosition({ ...facts, hurt: true, atProtection: true }), "hold");
  assert.equal(
    decideCombatPosition({ ...facts, protected: false, canDefendHere: true }),
    "attack",
    "a descending blaze in reach is answered without abandoning the passage",
  );
  assert.equal(
    findCombatPosition(arena(), new Vec3(0, 0, 0), [{ ...shooter, attack: "unmodelled" }], shooter, 64),
    null,
  );
});

test("shield coverage depends on firing angles rather than the number of mobs", () => {
  const origin = new Vec3(0, 0, 0);
  assert.equal(shieldCoverage(origin, [new Vec3(-1, 0, 8), new Vec3(0, 0, 8), new Vec3(1, 0, 8)]).coversAll, true);
  assert.equal(shieldCoverage(origin, [new Vec3(-8, 0, 0), new Vec3(8, 0, 0)]).coversAll, false);
});


test("a sealed recovery box and a roof five blocks above quarry are not productive fighting positions", () => {
  const world = arena();
  const origin = new Vec3(0, 0, 0);
  const target = { ...shooter, position: new Vec3(5.5, 0, 0.5), height: 2.9, attack: "melee" as const };
  assert.equal(roofEngagementAvailable(world, origin, target, 1.62), true);
  for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)])
    for (let y = 0; y <= 1; y++) world.load(side.offset(0, y, 0), { stateId: 1 });
  assert.equal(roofEngagementAvailable(world, origin, target, 1.62), false);
  world.load({ x: 0, y: 4, z: 0 }, { stateId: 1 });
  assert.equal(roofEngagementAvailable(world, new Vec3(0, 5, 0), target, 1.62), false);
});
