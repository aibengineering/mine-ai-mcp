import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CombatPerception } from "./observations.js";
import { Vec3 } from "vec3";
import type { HostileContext } from "../../control/combat/context.js";
import { observeHostileResponse } from "../../control/combat/observation.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { isThreat, observeHostileContact, shouldAvoidEntity, SPIDER_PASSIVE_SKY_LIGHT } from "./threats.js";

interface Mob {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  /** minecraft-data category; defaults to a hostile. */
  readonly kind?: string;
  /** minecraft-data type, which the policy must not rely on. */
  readonly type?: string;
  readonly metadata?: readonly unknown[];
}

test("waiting for contact is distinct from a response constrained by policy", () => {
  const waiting = botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 5 }] });
  assert.equal(observeHostileResponse(waiting).kind, "none");
  const contact = botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 2 }] });
  const result = observeHostileResponse(contact, context(), {
    ...DEFAULT_COMBAT_POLICY,
    melee: false,
    bow: false,
    shield: false,
    retreat: false,
    hide: "never",
  });
  assert.equal(result.kind, "constrained");
});

/** Midnight; the fixtures that care about the sun say so. */
const NIGHT_TICKS = 18_000;
const NOON_TICKS = 6_000;

/** The 1.21.4 enderman metadata layout, as minecraft-data reports it. */
const ENDERMAN_METADATA_KEYS = [
  "shared_flags",
  "air_supply",
  "custom_name",
  "custom_name_visible",
  "silent",
  "no_gravity",
  "pose",
  "ticks_frozen",
  "living_entity_flags",
  "health",
  "effect_particles",
  "effect_ambience",
  "arrow_count",
  "stinger_count",
  "sleeping_pos",
  "mob_flags",
  "carry_state",
  "creepy",
  "stared_at",
];
const CREEPY = ENDERMAN_METADATA_KEYS.indexOf("creepy");

function botWith(options: {
  readonly health?: number;
  readonly items?: readonly { readonly name: string; readonly count: number }[] | readonly string[];
  readonly mobs?: readonly Mob[];
  /** Defaults to midnight, so a spider is a threat unless a test says otherwise. */
  readonly timeOfDay?: number;
  /** Sky light every cell reports, for the daylight-spider rule. */
  readonly skyLight?: number;
  readonly position?: Vec3;
  readonly covered?: boolean | "low_wall";
  readonly air?: boolean;
}): Bot {
  const mobs = options.mobs ?? [];
  const items = (options.items ?? []).map((item, type) =>
    typeof item === "string" ? { name: item, type, count: 1 } : { ...item, type },
  );
  return {
    health: options.health ?? 20,
    food: 20,
    game: { gameMode: "survival", dimension: "overworld" },
    heldItem: null,
    time: { timeOfDay: options.timeOfDay ?? NIGHT_TICKS },
    blockAt: () => ({ skyLight: options.skyLight ?? 0, boundingBox: options.air ? "empty" : "block" }),
    world: {
      raycast: (from: Vec3, direction: Vec3) => {
        if (!options.covered) return null;
        // A wall at x=1, reaching y=1.5: a ray above its top stays clear.
        if (options.covered === "low_wall" && from.y + direction.y / direction.x >= 1.5) return null;
        return { position: new Vec3(1, 0, 0) };
      },
    },
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    registry: {
      entitiesByName: {
        ...minecraftData("1.21.4").entitiesByName,
        enderman: { metadataKeys: ENDERMAN_METADATA_KEYS },
        piglin: { metadataKeys: ["mob_flags", "baby"] },
      },
    },
    entity: { id: 1, width: 0.6, height: 1.8, position: options.position ?? new Vec3(0, 0, 0) },
    entities: Object.fromEntries(
      mobs.map((mob) => [
        mob.id,
        {
          id: mob.id,
          name: mob.name,
          displayName: mob.name,
          type: mob.type ?? "hostile",
          kind: "kind" in mob ? mob.kind : "Hostile mobs",
          isValid: true,
          height: 2,
          width: 0.6,
          metadata: mob.metadata ?? [],
          position: new Vec3(mob.x, 0, 0),
        },
      ]),
    ),
  } as unknown as Bot;
}

function context(
  options: {
    resolved?: number[];
    attackers?: number[];
    unreachable?: number[];
    blocked?: string[];
  } = {},
): HostileContext {
  return {
    resolvedIds: new Set(options.resolved),
    attackerIds: new Set(options.attackers),
    unreachableIds: new Set(options.unreachable),
    blockedResponses: new Set(options.blocked),
  };
}

test("native husks are hostile and defend at melee contact", () => {
  const husk = minecraftData("1.21.4").entitiesByName.husk!;
  const bot = botWith({ mobs: [{ id: 7, name: "husk", x: 2, kind: husk.category }], items: ["iron_sword"] });
  assert.equal(isThreat(bot, bot.entities[7], context()), true);
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

for (const name of ["skeleton", "stray", "bogged"]) {
  test(`${name} bow draw activates defence before a distant first hit`, () => {
    const bot = botWith({ mobs: [{ id: 7, name, x: 13 }], items: ["iron_sword", "shield"] });
    const mob = bot.entities[7]!;
    Reflect.set(mob, "heldItem", { name: "bow" });
    assert.equal(observeHostileResponse(bot).kind, "none");
    Reflect.set(mob.metadata, 8, 1);
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = 0;
    assert.equal(observeHostileResponse(bot).kind, "fight");
    assert.equal(observeHostileResponse(bot, context(), { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" }).kind, "evade");
    const covered = botWith({ covered: true, mobs: [{ id: 7, name, x: 13, metadata: mob.metadata }] });
    Reflect.set(covered.entities[7]!, "heldItem", { name: "bow" });
    Reflect.set(covered.entities[7]!, "headYaw", Math.PI / 2);
    covered.entities[7]!.pitch = 0;
    assert.equal(observeHostileResponse(covered).kind, "none");
  });
}

test("aimed bow draws bypass both observation radii, without treating other targets as contact", () => {
  const bot = botWith({ mobs: [{ id: 7, name: "zombie", x: 48 }], items: ["iron_sword", "shield"] });
  Object.setPrototypeOf(bot, new EventEmitter());
  Reflect.set(bot, "_client", new EventEmitter());
  const mob = bot.entities[7]!;
  Reflect.set(mob, "heldItem", { name: "bow" });
  Reflect.set(mob.metadata, 8, 1);
  Reflect.set(mob, "headYaw", Math.PI / 2);
  mob.pitch = 0;
  using perception = new CombatPerception(bot);
  const seen = { ...context(), perception };
  assert.equal(perception.read()[0]?.distance, 48);
  assert.equal(observeHostileResponse(bot, seen).kind, "fight");
  Reflect.set(mob, "headYaw", -Math.PI / 2);
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "head toward another target");
  Reflect.set(mob, "headYaw", Math.PI / 2);
  mob.pitch = Math.PI / 4;
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "aim above our body");
  Reflect.deleteProperty(mob, "headYaw");
  mob.pitch = 0;
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "missing head direction is not a target observation");
});

for (const name of ["blaze", "skeleton"]) {
  test(`withdrawal evades an observed distant ${name} attacker even at full health`, () => {
    const bot = botWith({ mobs: [{ id: 7, name, x: 20 }], items: ["diamond_sword", "shield"] });
    const threats = context({ attackers: [7] });
    assert.equal(observeHostileResponse(bot, threats).kind, "fight");
    const directive = observeHostileResponse(bot, threats, { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" });
    assert.equal(directive.kind, "evade");
    if (directive.kind === "evade") assert.equal(directive.reason, "withdraw");
  });
}

test("withdrawal retains emergency shelter and does not invent contact with hidden attackers", () => {
  const options = { mobs: [{ id: 7, name: "blaze", x: 20 }], items: ["diamond_sword", "cobblestone"] };
  assert.equal(
    observeHostileResponse(botWith({ ...options, health: 6 }), context({ attackers: [7] }), {
      ...DEFAULT_COMBAT_POLICY,
      engagement: "defend_only",
    }).kind,
    "hide",
  );
  assert.equal(
    observeHostileResponse(botWith({ ...options, covered: true }), context({ attackers: [7] }), {
      ...DEFAULT_COMBAT_POLICY,
      engagement: "defend_only",
    }).kind,
    "none",
  );
});

test("fights a hostile in contact while above half health", () => {
  const directive = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "zombie", x: 3 }] }));

  assert.equal(directive.kind, "fight");
  if (directive.kind === "fight") assert.equal(directive.targetId, 7);
});

test("a melee mob across a ledge cannot turn a journey into a hunt, even after an earlier hit", () => {
  const bot = botWith({ mobs: [{ id: 7, name: "magma_cube", x: 3 }] });
  bot.entities[7]!.position.y = -5;
  assert.deepEqual(observeHostileResponse(bot, context({ attackers: [7] })), { kind: "none" });
  bot.entities[7]!.position.y = 0;
  assert.equal(observeHostileResponse(bot).kind, "fight");
  bot.entities[7]!.position.x = 6;
  assert.equal(observeHostileResponse(bot).kind, "none");
  bot.health = 11;
  assert.equal(observeHostileResponse(bot).kind, "evade", "wounded avoidance retains its earlier warning range");
});

test("a jumping cube retains defensive contact before descending into swing reach", () => {
  const options = { mobs: [{ id: 7, name: "magma_cube", x: 2 }], air: true };
  const bot = botWith(options);
  const cube = bot.entities[7]!;
  cube.position.y = 6;
  assert.equal(observeHostileResponse(bot).kind, "fight", "do not start a journey underneath the airborne attacker");
  options.air = false;
  assert.equal(
    observeHostileResponse(bot).kind,
    "none",
    "a mob standing on an overhead ledge must not lock out travel",
  );
});

test("closed cover prevents contact even with a previous attacker or critically low health", () => {
  for (const health of [20, 7]) {
    const bot = botWith({ health, covered: true, mobs: [{ id: 7, name: "blaze", x: 5 }] });
    assert.deepEqual(observeHostileResponse(bot, context({ attackers: [7] })), { kind: "none" });
    assert.equal(observeHostileContact(bot).length, 1, "status still reports the nearby hostile behind cover");
  }
});

test("opening cover makes the same nearby hostile eligible immediately", () => {
  const options = { covered: true, mobs: [{ id: 7, name: "blaze", x: 5 }] };
  const bot = botWith(options);
  assert.deepEqual(observeHostileResponse(bot), { kind: "none" });
  options.covered = false;
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

test("a low wall that leaves the hostile's head exposed does not prevent contact", () => {
  const bot = botWith({ covered: "low_wall", mobs: [{ id: 7, name: "skeleton", x: 5 }] });
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

test("fights a crowd one body at a time, nearest first", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 8, name: "zombie", x: 3 },
        { id: 7, name: "zombie", x: 2 },
        { id: 9, name: "zombie", x: 12 },
      ],
    }),
  );

  // Being outnumbered is not a condition: the nearest hostile is the target and
  // the rest stay in the evidence rather than changing the decision.
  assert.equal(directive.kind, "fight");
  if (directive.kind !== "fight") return;
  assert.equal(directive.targetId, 7);
  assert.deepEqual(
    directive.threats.map((threat) => threat.id),
    [7, 8, 9],
  );
});

test("names the next target once the first is resolved", () => {
  const bot = botWith({
    mobs: [
      { id: 7, name: "zombie", x: 2 },
      { id: 8, name: "zombie", x: 3 },
    ],
  });

  const directive = observeHostileResponse(bot, context({ resolved: [7] }));

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 8);
});

test("recognises hostiles by minecraft-data category, not by the narrower entity type", () => {
  for (const [name, type] of [
    ["phantom", "mob"],
    ["slime", "mob"],
    ["ghast", "mob"],
    ["hoglin", "animal"],
    ["witch", "hostile"],
  ] as const) {
    const directive = observeHostileResponse(botWith({ mobs: [{ id: 7, name, type, x: 3 }] }));

    assert.equal(directive.kind, "fight", `expected to engage a ${name}`);
  }
});

test("leaves an enderman alone until it turns on the bot", () => {
  const calm = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "enderman", x: 4 }] }));
  const angryMetadata: unknown[] = [];
  angryMetadata[CREEPY] = true;
  const angry = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "enderman", x: 4, metadata: angryMetadata }] }));
  const struckBack = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "zombified_piglin", x: 3 }] }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(calm, { kind: "none" });
  assert.equal(angry.kind, "none");
  assert.equal(struckBack.kind, "fight");
});

/**
 * Piglins are filed as hostile mobs, but hitting one turns every piglin that
 * can see it, and a baby piglin never attacks anybody at all. Mineflayer names
 * adults and babies alike `piglin`, so the policy cannot tell them apart and
 * must not open the fight.
 *
 * Observed live on 2026-09-04: the bot walked into the Nether, closed on two
 * piglins that had not touched it, killed both without taking a scratch, and
 * angered a bastion holding forty-eight piglins and twelve brutes.
 */
test("leaves a piglin alone until it turns on the bot", () => {
  const calm = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "piglin", x: 3 }] }));
  const struckBack = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "piglin", x: 3 }] }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(calm, { kind: "none" }, "a piglin minding its own business is not a target");
  assert.equal(struckBack.kind, "fight", "a piglin that attacks is fought");
});

test("leaves passive mobs and players alone", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 7, name: "cow", kind: "Passive mobs", type: "animal", x: 3 },
        { id: 8, name: "player", kind: undefined, type: "player", x: 2 },
      ],
    }),
  );

  assert.deepEqual(directive, { kind: "none" });
});

test("a hostile that has hurt the bot is in contact from beyond the contact range", () => {
  const directive = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "skeleton", x: 13 }] }),
    context({ attackers: [7] }),
  );

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 7);
});

test("targets the nearest hostile in contact, not merely the nearest hostile", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 7, name: "zombie", x: 10 },
        { id: 8, name: "skeleton", x: 14 },
      ],
    }),
    context({ attackers: [8] }),
  );

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 8);
});

test("an unarmed bot evades any creeper in contact, however healthy it is", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 7, name: "zombie", x: 2 },
        { id: 8, name: "creeper", x: 7 },
      ],
    }),
  );

  assert.deepEqual(
    directive.kind === "evade"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) }
      : directive,
    {
      reason: "creeper",
      ids: [7, 8],
    },
  );
});

test("an armed bot fights a creeper; shared tactics own its physical defence", () => {
  for (const items of [["iron_sword"], ["bow", "arrow"]]) {
    const directive = observeHostileResponse(botWith({ items, mobs: [{ id: 8, name: "creeper", x: 7 }] }));

    assert.equal(directive.kind, "fight", `expected to fight with ${items.join("+")}`);
  }
});

test("a creeper in a crowd is fought last: the zombie behind it is the target", () => {
  const directive = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 4 },
        { id: 9, name: "zombie", x: 3 },
      ],
    }),
  );
  assert.equal(directive.kind === "fight" ? directive.targetId : directive, 9);

  // Out of contact, the zombie does not yet count; the creeper is the fight.
  const strungOut = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 4 },
        { id: 9, name: "zombie", x: 12 },
      ],
    }),
  );
  assert.equal(strungOut.kind === "fight" ? strungOut.targetId : strungOut, 8);
});

test("a bot without a bow evades two creepers in contact; with one it fights the pair", () => {
  const pair = [
    { id: 8, name: "creeper", x: 6 },
    { id: 9, name: "creeper", x: 7 },
  ];
  const sword = observeHostileResponse(botWith({ items: ["iron_sword"], mobs: pair }));
  assert.deepEqual(
    sword.kind === "evade" ? { reason: sword.reason, ids: sword.threats.map((threat) => threat.id) } : sword,
    {
      reason: "creeper",
      ids: [8, 9],
    },
  );

  const bow = observeHostileResponse(botWith({ items: ["bow", "arrow", "iron_sword"], mobs: pair }));
  assert.equal(bow.kind, "fight");

  // The second creeper counts from anywhere in observation range: a step
  // outside the contact boundary is a step from being the second fuse.
  const strungOut = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 6 },
        { id: 9, name: "creeper", x: 12 },
      ],
    }),
  );
  assert.equal(strungOut.kind, "evade");

  // Beyond observation range it is not yet part of this encounter.
  const distant = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 6 },
        { id: 9, name: "creeper", x: 20 },
      ],
    }),
  );
  assert.equal(distant.kind, "fight");
});

test("a creeper outside contact range does not change a fight", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 7, name: "zombie", x: 2 },
        { id: 8, name: "creeper", x: 12 },
      ],
    }),
  );

  assert.equal(directive.kind, "fight");
});

test("evades a target no route reached instead of walking back into its fire", () => {
  const directive = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "skeleton", x: 11 }] }),
    context({ attackers: [7], unreachable: [7] }),
  );

  assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, "unreachable");
});

test("a healthy defender can fight a formerly unreachable blaze that comes into exposed melee reach", () => {
  const directive = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "blaze", x: 2 }] }),
    context({ attackers: [7], unreachable: [7] }),
  );
  assert.equal(directive.kind, "fight");
});

test("failed approach memory still prevents pursuing a covered close blaze", () => {
  const directive = observeHostileResponse(
    botWith({ covered: true, mobs: [{ id: 7, name: "blaze", x: 2 }] }),
    context({ attackers: [7], unreachable: [7] }),
  );
  assert.notEqual(directive.kind, "fight");
});

test("still evades an ordinary hostile while wounded", () => {
  const directive = observeHostileResponse(
    botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health - 1, mobs: [{ id: 7, name: "zombie", x: 3 }] }),
  );

  assert.deepEqual(
    directive.kind === "evade"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) }
      : directive,
    {
      reason: "hurt",
      ids: [7],
    },
  );
});

test("shelters at eleven health from an enderman observed attacking us", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const bot = botWith({ health: 11, mobs: [{ id: 7, name: "enderman", x: 4, metadata }] });
  const directive = observeHostileResponse(bot, context({ attackers: [7] }));

  assert.deepEqual(
    directive.kind === "hide"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) }
      : directive,
    { reason: "hurt", ids: [7] },
  );
});

test("a wounded enderman encounter evades after the same hide attempt failed", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const bot = botWith({ health: 11, mobs: [{ id: 7, name: "enderman", x: 4, metadata }] });
  const directive = observeHostileResponse(bot, context({ blocked: ["hide"], attackers: [7] }));

  assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, "hurt");
});

test("enderman shelter does not change healthy fights, neutral encounters, or distant observation", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const angry = { id: 7, name: "enderman", x: 4, metadata };
  assert.equal(
    observeHostileResponse(
      botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health, mobs: [angry] }),
      context({ attackers: [7] }),
    ).kind,
    "fight",
  );
  assert.equal(observeHostileResponse(botWith({ health: 11, mobs: [{ id: 7, name: "enderman", x: 4 }] })).kind, "none");

  const distant = observeHostileResponse(
    botWith({
      health: 11,
      mobs: [
        { ...angry, x: 12 },
        { id: 8, name: "zombie", x: 2 },
      ],
    }),
  );
  assert.equal(distant.kind === "evade" ? distant.reason : distant.kind, "hurt");
});

test("wounded enderman shelter preserves creeper and unreachable priorities", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const angry = { id: 7, name: "enderman", x: 4, metadata };
  for (const items of [[], ["iron_sword"]]) {
    const creeper = observeHostileResponse(
      botWith({
        health: 11,
        items,
        mobs: [angry, { id: 8, name: "creeper", x: 4 }, { id: 9, name: "creeper", x: 12 }],
      }),
    );
    assert.equal(creeper.kind === "evade" ? creeper.reason : creeper.kind, "creeper");
  }

  const unreachable = observeHostileResponse(
    botWith({ health: 11, mobs: [angry] }),
    context({ unreachable: [7], attackers: [7] }),
  );
  assert.equal(unreachable.kind === "evade" ? unreachable.reason : unreachable.kind, "unreachable");
});

test("still fights at exactly the half-health threshold", () => {
  const directive = observeHostileResponse(
    botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health, mobs: [{ id: 7, name: "zombie", x: 3 }] }),
  );

  assert.equal(directive.kind, "fight");
});

test("evades every observed threat as one aggregate response", () => {
  const directive = observeHostileResponse(
    botWith({
      health: 10,
      mobs: [
        { id: 7, name: "zombie", x: 3 },
        { id: 8, name: "zombie", x: 12 },
        { id: 9, name: "zombie", x: 20 },
      ],
    }),
  );

  assert.deepEqual(
    directive.kind === "evade"
      ? { ids: directive.threats.map((threat) => threat.id), safeRange: directive.safeRange }
      : directive,
    { ids: [7, 8], safeRange: DEFAULT_COMBAT_POLICY.evade_safe_range },
  );
});

test("hides instead of running below the hide bar", () => {
  const directive = observeHostileResponse(
    botWith({
      health: DEFAULT_COMBAT_POLICY.critical_health - 1,
      mobs: [
        { id: 7, name: "zombie", x: 3 },
        { id: 8, name: "skeleton", x: 12 },
      ],
    }),
  );

  assert.deepEqual(
    directive.kind === "hide"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) }
      : directive,
    { reason: "hurt", ids: [7, 8] },
  );
});

test("under the hide bar a hostile merely in sight is reason enough to dig in", () => {
  const directive = observeHostileResponse(
    botWith({ health: DEFAULT_COMBAT_POLICY.critical_health - 1, mobs: [{ id: 7, name: "skeleton", x: 14 }] }),
  );

  assert.equal(directive.kind, "hide");
});

test("hides when the last evade could not get away, whatever the health", () => {
  const directive = observeHostileResponse(
    botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 3 }] }),
    context({ blocked: ["evade"] }),
  );

  assert.equal(directive.kind, "hide");
  if (directive.kind === "hide") assert.equal(directive.reason, "cornered");
});

/**
 * A spider is a hostile by Mineflayer's category at every hour, and vanilla
 * only sends it at anything in the dark. On 2026-09-04 a passive spider
 * standing in the open at fifteen blocks kept the hide trigger armed through
 * an entire morning, from which the bot never recovered.
 */
test("a spider in daylight is left alone; the same spider at night is a threat", () => {
  const spider = [{ id: 7, name: "spider", x: 3 }] as const;
  const daylight = observeHostileResponse(
    botWith({ mobs: spider, timeOfDay: NOON_TICKS, skyLight: SPIDER_PASSIVE_SKY_LIGHT }),
  );
  const dusk = observeHostileResponse(botWith({ mobs: spider, timeOfDay: NIGHT_TICKS, skyLight: 15 }));
  // Noon underground: the clock says day and the cell is unlit, so it hunts.
  const cave = observeHostileResponse(
    botWith({ mobs: spider, timeOfDay: NOON_TICKS, skyLight: SPIDER_PASSIVE_SKY_LIGHT - 1 }),
  );
  const provoked = observeHostileResponse(
    botWith({ mobs: spider, timeOfDay: NOON_TICKS, skyLight: 15 }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(daylight, { kind: "none" }, "a spider in the sun is not a threat");
  assert.equal(dusk.kind, "fight");
  assert.equal(cave.kind, "fight");
  assert.equal(provoked.kind, "fight", "a spider that bit the bot is fought whatever the sun is doing");
});

/**
 * The livelock of 2026-09-04: below the hide bar with a hide that could not be
 * built, the policy chose the same hide every tick, and each choice claimed
 * the body and cancelled the model's way out.
 */
test("a hide that failed here is not chosen again until something has changed", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const options = {
    health: DEFAULT_COMBAT_POLICY.critical_health - 1,
    mobs,
    items: [{ name: "cobblestone", count: 16 }],
  };
  const bot = botWith(options);

  assert.equal(observeHostileResponse(bot, context()).kind, "hide", "the first hide is chosen");
  assert.deepEqual(
    observeHostileResponse(bot, context({ blocked: ["hide"] })),
    {
      kind: "evade",
      threats: observeHostileContact(bot, context()),
      safeRange: DEFAULT_COMBAT_POLICY.evade_safe_range,
      reason: "hurt",
    },
    "another permitted response can be chosen without repeating hide",
  );
});

/**
 * Standing still is the better answer only while nothing is landing. The plan
 * that introduced the stand-down said so outright: being hit where the bot
 * stands is worse than the worst evade.
 */
test("damage re-arms the run even with a failed hide on record", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const options = { health: DEFAULT_COMBAT_POLICY.critical_health - 1, mobs };
  const bot = botWith(options);

  const ignored = observeHostileResponse(bot, context({ blocked: ["hide"] }));
  const bitten = observeHostileResponse(bot, context({ blocked: ["hide"], attackers: [7] }));

  assert.equal(ignored.kind, "evade");
  assert.deepEqual(
    bitten.kind === "evade" ? { reason: bitten.reason, ids: bitten.threats.map((threat) => threat.id) } : bitten,
    {
      reason: "hurt",
      ids: [7],
    },
  );
});

test("a failed hide is not the answer to a failed evade either", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const bot = botWith({ health: 20, mobs, items: ["iron_sword"] });

  const cornered = observeHostileResponse(bot, context({ blocked: ["evade"] }));
  const spent = observeHostileResponse(bot, context({ blocked: ["evade", "hide"] }));

  assert.equal(cornered.kind, "hide");
  // Healthy and out of holes: back to fighting rather than digging the hole
  // that already refused to be dug.
  assert.equal(spent.kind, "fight");
});

test("ignores a resolved target while its dying entity is still loaded", () => {
  const directive = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "zombie", x: 3 }] }),
    context({ resolved: [7] }),
  );

  assert.deepEqual(directive, { kind: "none" });
});

test("does not respond before a hostile enters contact range", () => {
  const directive = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "zombie", x: 9 }] }));

  assert.deepEqual(directive, { kind: "none" });
});

for (const health of [20, 10, 6]) {
  test(`an observed distant blaze attacker remains eligible at health ${health}`, () => {
    const bot = botWith({ health, items: ["iron_sword", "cobblestone"], mobs: [{ id: 7, name: "blaze", x: 28 }] });
    assert.equal(observeHostileResponse(bot).kind, "none", "a distant unprovoked mob remains outside passive contact");
    const observed = context({ attackers: [7] });
    assert.notEqual(observeHostileResponse(bot, observed).kind, "none");
    assert.deepEqual(
      observeHostileContact(bot, observed).map((threat) => threat.id),
      [7],
    );
    assert.equal(observeHostileResponse(bot, context({ attackers: [7], resolved: [7] })).kind, "none");
    const covered = botWith({ health, covered: true, mobs: [{ id: 7, name: "blaze", x: 28 }] });
    assert.equal(observeHostileResponse(covered, observed).kind, "none", "existing cover still ends contact");
  });
}

test("observed aggressive piglin remains subject to contact and exposure", () => {
  const mob = { id: 7, name: "piglin", x: 3, metadata: [4] };
  const bot = botWith({ mobs: [mob] });
  assert.equal(isThreat(bot, bot.entities[7], context()), false);
  assert.equal(shouldAvoidEntity(bot, bot.entities[7], context()), true);
  const response = observeHostileResponse(bot);
  assert.equal(response.kind, "evade");
  if (response.kind === "evade") assert.equal(response.reason, "observed_aggression");
  assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "fight");
  assert.equal(observeHostileResponse(botWith({ health: 6, mobs: [mob] })).kind, "hide");
  for (const flags of [undefined, 0, 1, 2, "4"]) {
    assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, metadata: [flags] }] })).kind, "none");
  }
  assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, metadata: [0, true] }] })).kind, "none");
  assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, x: 20 }] })).kind, "none");
  assert.equal(observeHostileResponse(botWith({ mobs: [mob], covered: true })).kind, "none");
});

test("wounded unguarded ranged contact seeks shelter, retaining guarded and failed-build escapes", () => {
  for (const name of ["blaze", "skeleton"]) {
    const bot = botWith({ health: 10, items: ["diamond_sword", "cobblestone"], mobs: [{ id: 7, name, x: 10 }] });
    if (name === "skeleton") Reflect.set(bot.entities[7]!, "heldItem", { name: "bow" });
    const seen = context({ attackers: [7] });
    assert.equal(observeHostileResponse(bot, seen).kind, "hide", name);
    assert.equal(
      observeHostileResponse(bot, context({ attackers: [7], unreachable: [7] })).kind,
      "hide",
      "failed pursuit is not a reason to run through ranged fire",
    );
    assert.equal(
      observeHostileResponse(bot, context({ attackers: [7], blocked: ["hide"] })).kind,
      "evade",
      "construction refusal retains the escape fallback",
    );
    const guarded = botWith({ health: 10, items: ["diamond_sword", "shield"], mobs: [{ id: 7, name, x: 10 }] });
    if (name === "skeleton") Reflect.set(guarded.entities[7]!, "heldItem", { name: "bow" });
    assert.equal(observeHostileResponse(guarded, seen).kind, "evade", "a carried shield preserves guarded travel");
  }
});

test("an existing burn needs recovery even when a shield can block future ranged hits", () => {
  for (const name of ["blaze", "skeleton"]) {
    const bot = botWith({
      health: 10,
      items: ["shield", "diamond_sword", "cobblestone"],
      mobs: [{ id: 7, name, x: 10 }],
    });
    if (name === "skeleton") Reflect.set(bot.entities[7]!, "heldItem", { name: "bow" });
    bot.entity.metadata = [];
    const flags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
    Reflect.set(bot.entity.metadata, flags, 1);
    assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "hide");
    Reflect.set(bot.entity.metadata, flags, 0);
    assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "evade");
  }
});

test("an Enderman angry at an unknown victim never authorizes attack or shelter", () => {
  const metadata: unknown[] = [];
  metadata[CREEPY] = true;
  for (const health of [20, 11, 4]) {
    const bot = botWith({ health, mobs: [{ id: 7, name: "enderman", x: 2, metadata }] });
    assert.equal(isThreat(bot, bot.entities[7], context()), false);
    assert.equal(shouldAvoidEntity(bot, bot.entities[7], context()), false);
    assert.deepEqual(observeHostileResponse(bot), { kind: "none" });
    assert.notEqual(observeHostileResponse(bot, context({ attackers: [7] })).kind, "none");
  }
});

test("angry head attention starts defense before a hit, not body orientation or anger alone", () => {
  for (const health of [20, 11, 4]) {
    const metadata: unknown[] = [];
    metadata[CREEPY] = true;
    const bot = botWith({ health, mobs: [{ id: 7, name: "enderman", x: 6, metadata }] });
    const mob = bot.entities[7]!;
    mob.yaw = -Math.PI / 2; // Body away, head toward this bot.
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = Math.atan2(1.62 - 2.55, 6);
    assert.equal(isThreat(bot, mob, context()), true);
    assert.notEqual(observeHostileResponse(bot).kind, "none");
    Reflect.set(mob, "headYaw", -Math.PI / 2);
    mob.yaw = Math.PI / 2;
    assert.equal(isThreat(bot, mob, context()), false, "head aimed at someone else");
    assert.equal(observeHostileResponse(bot).kind, "none");
    assert.equal(isThreat(bot, mob, context({ attackers: [7] })), true, "known attacker briefly turning");
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = Math.PI / 4;
    assert.equal(isThreat(bot, mob, context()), false, "looking above us at a flying target");
    mob.pitch = Math.atan2(1.62 - 2.55, 6) + (2 * Math.PI) / 256;
    assert.equal(isThreat(bot, mob, context()), true, "packet angle quantisation");
    metadata[CREEPY] = false;
    assert.equal(isThreat(bot, mob, context()), false, "calm eye contact");
  }
});
