import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { HostileContext } from "../../control/combat/context.js";
import { DEFAULT_COMBAT_POLICY, type CombatPolicy } from "../../policy/combat/contract.js";
import { DEFAULT_NAVIGATION_POLICY } from "../../policy/contract.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import {
  createHostileStepFieldProvider,
  HIDE_EXPOSURE_PENALTY,
  HOSTILE_AVOIDANCE_CAP,
  SEVERE_AVOIDANCE_STACK,
} from "./hostile-field.js";

/** What a cell packed with severe hostiles is worth once the cap has stopped rising. */
const SEVERE_CAP = HOSTILE_AVOIDANCE_CAP * SEVERE_AVOIDANCE_STACK;

interface Mob {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y?: number;
  readonly z?: number;
  /** minecraft-data category; defaults to a hostile. */
  readonly kind?: string;
  readonly metadata?: readonly unknown[];
}

interface BotOptions {
  /** Full unless a test is about the hide bar. */
  readonly health?: number;
  /** What a sight line meets; open air unless a test builds a wall. */
  readonly raycast?: (from: Vec3, direction: Vec3, range: number) => unknown;
}

function botWith(mobs: readonly Mob[], options: BotOptions = {}): Bot {
  return {
    health: options.health ?? 20,
    // Night, because a spider is only priced as a threat while it is one.
    time: { timeOfDay: 18_000 },
    blockAt: () => null,
    world: { raycast: options.raycast ?? (() => null) },
    registry: { entitiesByName: { piglin: { metadataKeys: ["mob_flags"] } } },
    entity: { id: 1, position: new Vec3(0, 0, 0), width: 0.6, height: 1.8 },
    entities: Object.fromEntries(
      mobs.map((mob) => [
        mob.id,
        {
          id: mob.id,
          name: mob.name,
          displayName: mob.name,
          type: "hostile",
          kind: "kind" in mob ? mob.kind : "Hostile mobs",
          isValid: true,
          metadata: mob.metadata ?? [],
          position: new Vec3(mob.x, mob.y ?? 0, mob.z ?? 0),
          width: 0.6,
          height: 1.95,
        },
      ]),
    ),
  } as unknown as Bot;
}

function context(
  options: { attackers?: number[]; resolved?: number[] } = {},
): HostileContext & { policy: CombatPolicy } {
  return {
    policy: DEFAULT_COMBAT_POLICY,
    resolvedIds: new Set(options.resolved),
    attackerIds: new Set(options.attackers),
    unreachableIds: new Set(),
  };
}

function fieldFor(mobs: readonly Mob[], threats = context(), options: BotOptions = {}) {
  return createHostileStepFieldProvider(botWith(mobs, options), threats, () => null, () => DEFAULT_NAVIGATION_POLICY)();
}

test("nothing to avoid is no field at all", () => {
  assert.equal(fieldFor([]), null);
  // A cow is not a threat, and neither is a hostile the reflex already killed.
  assert.equal(fieldFor([{ id: 7, name: "cow", x: 2, kind: "Passive mobs" }]), null);
  assert.equal(fieldFor([{ id: 7, name: "zombie", x: 2 }], context({ resolved: [7] })), null);
});

test("an admitted evade keeps proximity costs without repricing its escape as a new hide", () => {
  const bot = botWith([{ id: 7, name: "zombie", x: 10 }], { health: 7 });
  let response: "evade" | null = "evade";
  const provider = createHostileStepFieldProvider(bot, context(), () => response, () => DEFAULT_NAVIGATION_POLICY);
  const escaping = provider();
  assert.equal(escaping?.costAt(6, 0, 0), 10);
  response = null;
  const ordinary = provider();
  assert.equal(ordinary?.costAt(6, 0, 0), 10 + HIDE_EXPOSURE_PENALTY);
  assert.notEqual(escaping?.fingerprint, ordinary?.fingerprint);
});

test("a hostile's cost falls off linearly to nothing at its radius", () => {
  // A zombie: eight blocks of reach, twenty ticks at its own cell. Twenty ticks
  // is five sprinting blocks, so standing on it is worth a five-block detour.
  const field = fieldFor([{ id: 7, name: "zombie", x: 0 }]);
  assert.notEqual(field, null);
  if (!field) return;

  assert.equal(field.costAt(0, 0, 0), 20);
  assert.equal(field.costAt(2, 0, 0), 15);
  assert.equal(field.costAt(4, 0, 0), 10);
  assert.equal(field.costAt(6, 0, 0), 5);
  // Zero exactly at the radius, and nothing beyond it.
  assert.equal(field.costAt(8, 0, 0), 0);
  assert.equal(field.costAt(20, 0, 0), 0);
});

test("live policy scales capped proximity for evasion and ordinary routes, preserves exposure, and expires", async () => {
  const bot = botWith(
    Array.from({ length: 8 }, (_, index) => ({ id: index + 2, name: "creeper", x: 0 })),
    { health: 7 },
  );
  let now = 0;
  const policy = new SurvivalPolicyState(bot, () => now);
  let response: "evade" | null = "evade";
  const provider = createHostileStepFieldProvider(bot, context(), () => response, () => policy.effective.navigation);
  const original = provider()!;
  assert.equal(original.costAt(0, 0, 0), SEVERE_CAP);
  for (const multiplier of [2, 0.5, 0]) {
    await policy.edit({
      operation: "set",
      expected_revision: policy.snapshot().revision,
      changes: { navigation: { hostile_avoidance_multiplier: multiplier } },
      lifetime: { kind: "for", duration_ms: 1000 },
      reason: "Adjust route caution for this escape",
    });
    response = "evade";
    const escaping = provider()!;
    assert.equal(escaping.costAt(0, 0, 0), SEVERE_CAP * multiplier);
    assert.equal(escaping.costAt(24, 0, 0), 0, "the species radius stays unchanged");
    assert.notEqual(escaping.fingerprint, original.fingerprint);
    assert.equal(original.costAt(0, 0, 0), SEVERE_CAP, "an existing search keeps its snapshot");
    response = null;
    assert.equal(provider()!.costAt(0, 0, 0), SEVERE_CAP * multiplier + HIDE_EXPOSURE_PENALTY);
  }
  now = 1000;
  await policy.refresh();
  response = "evade";
  assert.equal(provider()!.costAt(0, 0, 0), SEVERE_CAP);
  assert.equal(provider()!.fingerprint, original.fingerprint);
  assert.deepEqual(policy.snapshot().overrides, []);
});

test("distance is measured in three dimensions", () => {
  const field = fieldFor([{ id: 7, name: "zombie", x: 0, y: 0, z: 0 }]);
  assert.notEqual(field, null);
  if (!field) return;

  // A hostile below does not price the cell overhead any less than one beside
  // it prices the cell alongside; a cave ceiling is not a defence the field
  // knows about, but eight blocks of rock still puts the cell out of reach.
  assert.equal(field.costAt(0, 4, 0), 10);
  assert.equal(field.costAt(0, 8, 0), 0);
  // Diagonally: five blocks away in the xz plane costs the same as five along one axis.
  assert.equal(field.costAt(3, 0, 4), 20 * (1 - 5 / 8));
});

test("the species table prices what each hostile actually does", () => {
  const cells = (mob: Mob, at: readonly [number, number, number]) => {
    const field = fieldFor([mob]);
    return field ? field.costAt(at[0], at[1], at[2]) : 0;
  };

  // A creeper's mistake is unrecoverable, so it is the dearest and reaches
  // further than a melee mob.
  assert.equal(cells({ id: 1, name: "creeper", x: 0 }, [0, 0, 0]), 50);
  assert.equal(cells({ id: 1, name: "creeper", x: 0 }, [11, 0, 0]), 50 * (1 - 11 / 24));
  // A skeleton is ranged: distance is the whole defence, so it reaches past
  // the range from which the first arrow comes.
  assert.equal(cells({ id: 2, name: "skeleton", x: 0 }, [12, 0, 0]), 30 * (1 - 12 / 24));
  // A spider is fast but weak, and is cheaper at the same reach than a zombie.
  assert.equal(cells({ id: 3, name: "spider", x: 0 }, [0, 0, 0]), 15);
  // A wither skeleton hits hard and its drain outlasts the escape, so it is
  // priced like a brute rather than like the zombie an unlisted melee mob gets.
  assert.equal(cells({ id: 5, name: "wither_skeleton", x: 0 }, [0, 0, 0]), 50);
  assert.equal(cells({ id: 5, name: "wither_skeleton", x: 0 }, [6, 0, 0]), 50 * (1 - 6 / 24));
  // Anything unlisted is priced like a zombie rather than ignored.
  assert.equal(cells({ id: 4, name: "drowned", x: 0 }, [0, 0, 0]), 20);
});

test("a mob that wins the fight on arrival is priced before it can start one", () => {
  const cells = (mob: Mob, at: readonly [number, number, number]) => {
    const field = fieldFor([mob]);
    return field ? field.costAt(at[0], at[1], at[2]) : 0;
  };

  // Sixteen blocks is where vanilla hands the mob the decision. The field must
  // still have slope there, or the cheapest route the search believes is safe
  // is one that walks into acquisition range for nothing - which is how the
  // 2026-09-13 live run arrived at a bastion it could not survive.
  for (const name of ["piglin_brute", "creeper", "wither_skeleton", "skeleton", "blaze", "ghast"]) {
    assert.ok(cells({ id: 1, name, x: 0 }, [16, 0, 0]) > 0, `${name} is priced at acquisition range`);
    assert.equal(cells({ id: 1, name, x: 0 }, [24, 0, 0]), 0, `${name} stops at its radius`);
  }
  assert.equal(cells({ id: 1, name: "piglin_brute", x: 0 }, [16, 0, 0]), 50 * (1 - 16 / 24));

  // A mob worth walking away from keeps the contact boundary: a zombie's own
  // follow range is more than twice a brute's, and pricing that would put a
  // cost on most of the map to avoid a fight that is survivable anyway.
  assert.equal(cells({ id: 2, name: "zombie", x: 0 }, [12, 0, 0]), 0);
  assert.equal(cells({ id: 2, name: "husk", x: 0 }, [12, 0, 0]), 0);
  assert.equal(cells({ id: 3, name: "spider", x: 0 }, [12, 0, 0]), 0);
});

test("overlapping hostiles sum, and the sum is capped at two terrain breaks", () => {
  const pair = fieldFor([
    { id: 7, name: "zombie", x: 0 },
    { id: 8, name: "zombie", x: 4 },
  ]);
  assert.notEqual(pair, null);
  if (!pair) return;
  // Halfway between the two: two blocks from each, so fifteen ticks apiece.
  // Walking between a pair costs more than passing either one alone, which is
  // the whole reason contributions sum rather than taking the largest.
  assert.equal(pair.costAt(2, 0, 0), 30);
  assert.equal(pair.costAt(0, 0, 0), 20 + 10);

  // A pack must not stack to an absurd number: no cell is ever worth more than
  // the dug blocks the cap allows.
  const pack = fieldFor(Array.from({ length: 8 }, (_unused, index) => ({ id: index + 1, name: "creeper", x: 0 })));
  assert.notEqual(pack, null);
  if (!pack) return;
  assert.equal(pack.costAt(0, 0, 0), SEVERE_CAP);
  assert.equal(HOSTILE_AVOIDANCE_CAP, 50);
  assert.equal(SEVERE_CAP, 150);
});

test("the cap rises with the severe hostiles reaching a cell, so a group prices above one of them", () => {
  const brutes = (count: number) =>
    fieldFor(Array.from({ length: count }, (_unused, index) => ({ id: index + 1, name: "piglin_brute", x: 0 })));

  // A single brute contributes exactly the base cap at its own cell, so under
  // a flat bound a bastion priced identically to a lone straggler and the
  // route could not tell the two apart. Each further one reaching the cell is
  // another fight, and buys another two dug blocks of detour.
  assert.equal(brutes(1)?.costAt(0, 0, 0), HOSTILE_AVOIDANCE_CAP);
  assert.equal(brutes(2)?.costAt(0, 0, 0), HOSTILE_AVOIDANCE_CAP * 2);
  assert.equal(brutes(3)?.costAt(0, 0, 0), SEVERE_CAP);
  // It stays a cap: past a few the answer stopped being a route, and ground
  // the search must still cross to leave must not become impassable.
  assert.equal(brutes(12)?.costAt(0, 0, 0), SEVERE_CAP);

  // Only the ones that reach the cell count. A brute across the valley is
  // outside its own radius here, so it raises nothing.
  const split = fieldFor([
    { id: 1, name: "piglin_brute", x: 0 },
    { id: 2, name: "piglin_brute", x: 0 },
    { id: 3, name: "piglin_brute", x: 80 },
  ]);
  assert.equal(split?.costAt(0, 0, 0), HOSTILE_AVOIDANCE_CAP * 2);

  // Ranged mobs are not severe. The cap exists partly because proximity cannot
  // test line of sight, and a wall of skeletons behind rock must not price a
  // route none of them can shoot.
  const skeletons = fieldFor(
    Array.from({ length: 8 }, (_unused, index) => ({ id: index + 1, name: "skeleton", x: 0 })),
  );
  assert.equal(skeletons?.costAt(0, 0, 0), HOSTILE_AVOIDANCE_CAP);
});

test("a neutral costs nothing until it has been provoked", () => {
  // The reflex leaves an unprovoked piglin alone; a route that detoured around
  // one would be paying for a fight nobody is having.
  assert.equal(fieldFor([{ id: 7, name: "piglin", x: 0 }]), null);
  assert.equal(fieldFor([{ id: 7, name: "zombified_piglin", x: 0 }]), null);

  const provoked = fieldFor([{ id: 7, name: "piglin", x: 0 }], context({ attackers: [7] }));
  assert.notEqual(provoked, null);
  assert.equal(provoked?.costAt(0, 0, 0), 20);
});

test("the fingerprint follows the threats and the blocks they stand in", () => {
  const still = fieldFor([{ id: 7, name: "zombie", x: 2.2, y: 0.0, z: 3.7 }]);
  const shuffled = fieldFor([{ id: 7, name: "zombie", x: 2.9, y: 0.0, z: 3.1 }]);
  const moved = fieldFor([{ id: 7, name: "zombie", x: 3.1, y: 0.0, z: 3.7 }]);
  const joined = fieldFor([
    { id: 7, name: "zombie", x: 2.2, y: 0.0, z: 3.7 },
    { id: 8, name: "zombie", x: 9.0, y: 0.0, z: 0.0 },
  ]);

  // A step inside one block answers identically, so it must not invent a new
  // search; a step across the boundary changes the answer and must.
  assert.equal(shuffled?.fingerprint, still?.fingerprint);
  assert.notEqual(moved?.fingerprint, still?.fingerprint);
  assert.notEqual(joined?.fingerprint, still?.fingerprint);
});

test("the fingerprint does not depend on the order the entity table was in", () => {
  const ascending = fieldFor([
    { id: 7, name: "zombie", x: 1 },
    { id: 8, name: "skeleton", x: 2 },
  ]);
  const descending = fieldFor([
    { id: 8, name: "skeleton", x: 2 },
    { id: 7, name: "zombie", x: 1 },
  ]);

  assert.equal(descending?.fingerprint, ascending?.fingerprint);
});

test("observed aggressive piglin is priced for avoidance without attacker attribution", () => {
  const piglin = { id: 7, name: "piglin", x: 0, metadata: [4] };
  assert.ok(fieldFor([piglin])?.costAt(0, 0, 0));
  assert.equal(fieldFor([{ ...piglin, metadata: [0] }]), null);
  assert.equal(fieldFor([piglin], context({ resolved: [7] })), null);
});

/**
 * The 2026-09-09 livelock: a bot at two health, a zombie eleven blocks off on
 * a ledge, and a route that walked back into its sight line every time. Under
 * the hide bar a cell the hostile can see is priced as the hide it provokes.
 */
test("under the hide bar, a cell the hostile can see costs twenty terrain breaks more than one it cannot", () => {
  // A wall halfway through cell 4, between the zombie at x = 10 and everything
  // west of it: a sight line meets the wall when it crosses that plane.
  const wall = (from: Vec3, direction: Vec3, range: number) => {
    const to = from.plus(direction.scaled(range));
    return from.x < 4.5 !== to.x < 4.5 ? { position: { x: 4, y: 0, z: 0 } } : null;
  };
  const zombie = { id: 7, name: "zombie", x: 10 };
  const hurt = fieldFor([zombie], context(), { health: 7, raycast: wall });
  const healthy = fieldFor([zombie], context(), { health: 20, raycast: wall });
  assert.notEqual(hurt, null);
  assert.notEqual(healthy, null);
  if (!hurt || !healthy) return;

  // Four blocks from the zombie and in plain sight: the proximity price plus
  // the exposure price. Healthy, the same cell costs proximity alone.
  assert.equal(hurt.costAt(6, 0, 0), 10 + HIDE_EXPOSURE_PENALTY);
  assert.equal(healthy.costAt(6, 0, 0), 10);
  // Behind the wall only proximity is priced, however hurt the bot is.
  assert.equal(hurt.costAt(3, 0, 0), 2.5);
  assert.equal(healthy.costAt(3, 0, 0), 2.5);
  // The wall stands in cell 4 itself. A body there would have dug it, and its
  // own cells never hide it: the sight line starts beyond them, in the open.
  assert.equal(hurt.costAt(4, 0, 0), 5 + HIDE_EXPOSURE_PENALTY);
  // In sight but beyond observation range is not contact, so it is not priced.
  assert.equal(hurt.costAt(30, 0, 0), 0);
  assert.equal(HIDE_EXPOSURE_PENALTY, 500);
  // Pricing sight changes every answer, so the two snapshots are different searches.
  assert.notEqual(hurt.fingerprint, healthy.fingerprint);

  // Exposure sits outside the proximity cap, which exists only because
  // proximity cannot test sight.
  const pack = fieldFor(
    Array.from({ length: 8 }, (_unused, index) => ({ id: index + 1, name: "creeper", x: 10 })),
    context(),
    { health: 7, raycast: wall },
  );
  assert.equal(pack?.costAt(9, 0, 0), SEVERE_CAP + HIDE_EXPOSURE_PENALTY);
});
