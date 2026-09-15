import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { combatTestContext } from "../../test-support/combat.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { hideInPlace } from "./hide.js";
import { capBlock, countCapBlocks, DRAGON_PROTECTION_BLOCKS } from "../positioning/combat/hide-blocks.js";

/** A cell as the hide reads it: only `boundingBox` decides whether it is solid. */
function stone(): unknown {
  return {
    name: "stone",
    boundingBox: "block",
    shapes: [[0, 0, 0, 1, 1, 1]],
    hardness: 1.5,
    position: new Vec3(0, 0, 0),
  };
}

function air(): unknown {
  return { name: "air", boundingBox: "empty", shapes: [], hardness: 0, position: new Vec3(0, 0, 0) };
}

function botIn(options: {
  readonly health: number;
  /** Hunger; full unless a test is about what the hold can do without food. */
  readonly food?: number;
  /** What stands at each cell; null is an unloaded cell. */
  readonly blockAt: (position: Vec3) => unknown;
  readonly items?: readonly { readonly name: string; readonly count: number }[];
  /** Thrown by `equip`, which is the first thing a placement does. */
  readonly equipError?: string;
}): Bot {
  const events = new EventEmitter();
  return {
    on: (event: string, listener: () => void) => {
      events.on(event, listener);
      if (event === "physicsTick")
        queueMicrotask(() => {
          for (let i = 0; i < 30; i++) events.emit(event);
        });
    },
    off: (event: string, listener: () => void) => events.off(event, listener),
    health: options.health,
    food: options.food ?? 20,
    version: "1.21.4",
    registry: minecraftData("1.21.4"),
    game: { gameMode: "survival" },
    heldItem: null,
    entity: { id: 1, onGround: true, position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 },
    entities: {},
    inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) },
    world: { raycast: () => null },
    blockAt: options.blockAt,
    clearControlStates: () => undefined,
    deactivateItem: () => undefined,
    setControlState: () => undefined,
    _client: { write: () => undefined },
    equip: async () => {
      if (options.equipError) throw new Error(options.equipError);
    },
    waitForTicks: async () => undefined,
  } as unknown as Bot;
}

function hide(bot: Bot): ReturnType<typeof hideInPlace> {
  return hideInPlace(bot, {
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: DEFAULT_COMBAT_POLICY.recovery_timeout_ms,
  });
}

test("soul-sand support uses the observed lower surface when centering a shelter", async () => {
  const bot = botIn({
    health: 20,
    items: [{ name: "cobblestone", count: 32 }],
    equipError: "placement reached after valid soul-sand support",
    blockAt: (position) =>
      position.y < 64
        ? { name: "soul_sand", boundingBox: "block", shapes: [[0, 0, 0, 1, 0.875, 1]], hardness: 0.5, position }
        : air(),
  });
  bot.entity.position.y = 63.875;
  const result = await hide(bot);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /placement reached after valid soul-sand support/);
  assert.doesNotMatch(result.error ?? "", /solid floor/);
});

test("same-cell knockback into a planned wall recenters before continuing construction", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: [{ name: "cobblestone", count: 32 }],
  });
  let equips = 0;
  let recentered = false;
  bot.equip = async () => {
    if (++equips === 1) bot.entity.position.x = 0.15;
    throw new Error("placement boundary");
  };
  bot.setControlState = (_control, state) => {
    if (state && bot.entity.position.x === 0.15) {
      bot.entity.position.x = 0.5;
      recentered = true;
    }
  };
  await hide(bot);
  assert.equal(recentered, true, "the body still occupies the same cell but overlaps its west wall");
});

/**
 * A successful hide guaranteed a failing one thirty seconds later: every side
 * of the box already solid, nothing left to place, and the runtime reporting
 * its safety net broken from inside a working shelter. On 2026-09-04 the model
 * could not walk the bot out of that box because the failing hide reclaimed
 * the body every second.
 */
test("a bot already sealed in is hidden, not failed", async () => {
  const result = await hide(botIn({ health: 18, blockAt: () => stone() }));

  assert.equal(result.kind, "recovered");
  assert.equal(result.enclosed, true);
  assert.equal(result.dug, 0);
  assert.equal(result.walled, 0);
  assert.equal(result.error, undefined);
});

test("dragon shelter counts and selects resistant blocks and rejects an ordinary stone enclosure", async () => {
  const bot = botIn({ health: 18, blockAt: () => stone(), items: [
    { name: "cobblestone", count: 64 }, { name: "end_stone", count: 10 },
  ] });
  assert.equal(countCapBlocks(bot, DRAGON_PROTECTION_BLOCKS), 10);
  assert.equal(capBlock(bot, DRAGON_PROTECTION_BLOCKS)?.name, "end_stone");
  const result = await hideInPlace(bot, {
    threatContext: combatTestContext(bot), signal: new AbortController().signal,
    recoverTo: 18, maximumMs: 90_000, blockNames: DRAGON_PROTECTION_BLOCKS,
  });
  assert.equal(result.kind, "failed");
  assert.equal(result.enclosed, false, "ordinary stone can be destroyed by the dragon");
});

/**
 * The open-ground failure of 2026-09-04: nothing dug, nothing walled, not
 * capped, on ordinary ground with forty-seven blocks carried, and a record
 * that named no cause. The refusal now travels with the failure.
 */
test("a failed hide reports the first refused placement, with the cell and the face it chose", async () => {
  const result = await hide(
    botIn({
      health: 7,
      blockAt: (position) => (position.y < 64 ? stone() : air()),
      // Enough to wall in rather than dig, which is the live failure's shape.
      items: [{ name: "cobblestone", count: 47 }],
      equipError: "the server would not equip cobblestone",
    }),
  );

  assert.equal(result.kind, "failed");
  // Ground below and open air at head height is not a box.
  assert.equal(result.enclosed, false);
  assert.match(result.error ?? "", /1,64,0/, "the cell the block was meant for");
  // The only solid neighbour of that cell is the ground beneath it, so the
  // block is placed on its upper face.
  assert.match(result.error ?? "", /cobblestone against stone face 0,1,0/, "the support face it chose");
  assert.match(result.error ?? "", /the server would not equip cobblestone/, "what the placement said");
});

test("with nothing to dig and nothing to place, the failure says the bot carried nothing", async () => {
  const result = await hide(botIn({ health: 7, blockAt: () => null }));

  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no block worth placing is carried/);
});

test("a wall-in that cannot clear the body's overlap refuses before placing walls", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: [{ name: "cobblestone", count: 32 }],
  });
  bot.entity.position.z = 0.146;
  let equips = 0;
  bot.equip = async () => {
    equips += 1;
  };
  const result = await hide(bot);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /could not centre inside/);
  assert.equal(equips, 0);
  assert.equal(result.walled, 0);
});

test("wall centering does not walk off adjacent lip support into an unsupported origin cell", async () => {
  const bot = botIn({ health: 20, blockAt: () => air(), items: [{ name: "cobblestone", count: 32 }] });
  bot.entity.position.z = 0.146;
  let controls = 0;
  bot.setControlState = () => {
    controls += 1;
  };
  const result = await hide(bot);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no solid floor/);
  assert.equal(controls, 0);
});

test("a partial collision block without center-height footing is not a wall-in floor", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? { ...(stone() as object), shapes: [[0, 0, 0, 1, 0.5, 1]] } : air()),
    items: [{ name: "cobblestone", count: 32 }],
  });
  const result = await hide(bot);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no solid floor/);
});

test("breaking a block without falling into its cell is a failed hide, even at full health", async () => {
  let broken = false;
  const bot = botIn({
    health: 20,
    blockAt: (position) => {
      if (position.y >= 64 || (broken && position.y === 63)) return air();
      return { ...(stone() as object), position, digTime: () => 750 };
    },
  });
  bot.game = { gameMode: "survival" } as Bot["game"];
  bot.dig = async () => {
    broken = true;
  };
  const result = await hide(bot);
  assert.equal(result.kind, "failed");
  assert.equal(result.dug, 1);
  assert.match(result.error ?? "", /did not land/);
});

function closeMob(name: string): Bot["entity"] {
  return {
    id: 2,
    name,
    kind: "Hostile mobs",
    type: "mob" as const,
    isValid: true,
    width: 0.6,
    height: 2,
    metadata: [],
    position: new Vec3(0.5, 64, 0.9),
  } as unknown as Bot["entity"];
}

test("hide repels an authorized intruder before building and uses the observed landing cell", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: [{ name: "cobblestone", count: 32 }],
    equipError: "placement boundary",
  });
  const mob = closeMob("wither_skeleton");
  bot.entities[2] = mob;
  bot.lookAt = async () => undefined;
  let attacks = 0;
  bot.attack = () => {
    attacks++;
    mob.position.x = 10;
    bot.entity.position.x = 3.5;
  };
  const result = await hide(bot);
  assert.equal(attacks, 1);
  assert.equal(result.swings, 1);
  assert.match(result.error ?? "", /4,64,0/);
});

test("a neutral piglin sharing the construction space is not permission to attack", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: [{ name: "cobblestone", count: 32 }],
    equipError: "placement boundary",
  });
  bot.entities[2] = closeMob("piglin");
  bot.attack = () => {
    throw new Error("neutral mob attacked");
  };
  const result = await hide(bot);
  assert.equal(result.swings, 0);
  assert.equal(result.kind, "failed");
});

test("shelter contact uses a ready shield and a non-sweeping tool beside a neutral Enderman", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: ["iron_sword", "iron_pickaxe", "shield", "cobblestone"].map((name) => ({ name, count: 32 })),
  });
  const intruder = closeMob("wither_skeleton");
  const bystander = Object.assign(closeMob("enderman"), { id: 3, position: new Vec3(2, 64, 0.5) });
  bot.entities[2] = intruder;
  bot.entities[3] = bystander;
  let raised = false;
  let ticks = 0;
  let raisedAt = 0;
  bot.on("physicsTick", () => {
    ticks++;
  });
  bot.equip = async (item, destination) => {
    if (typeof item === "number") throw new Error("Fixture expects a resolved item.");
    if (item.name === "cobblestone") throw new Error("construction boundary");
    if (destination === "hand") Reflect.set(bot, "heldItem", item);
    else bot.inventory.slots[45] = item;
  };
  bot.activateItem = () => {
    if (!raised) raisedAt = ticks;
    raised = true;
    Reflect.set(bot, "usingHeldItem", true);
  };
  bot.deactivateItem = () => {
    raised = false;
    Reflect.set(bot, "usingHeldItem", false);
  };
  bot.lookAt = async () => undefined;
  bot.attack = (target) => {
    assert.equal(target.id, intruder.id);
    assert.equal(bot.heldItem?.name, "iron_pickaxe");
    assert.equal(raised, true);
    assert.ok(ticks - raisedAt >= 5);
    delete bot.entities[2];
  };
  const result = await hide(bot);
  assert.equal(result.swings, 1);
  assert.equal(bystander.isValid, true);
  assert.equal(raised, false, "the construction owner releases its shield on settlement");
});

test("a stopped physics stream does not prevent hide cancellation", async () => {
  const bot = botIn({ health: 20, blockAt: () => air() });
  bot.entity.onGround = false;
  const events = new EventEmitter();
  bot.on = (event, listener) => {
    events.on(event, listener);
    return bot;
  };
  bot.off = (event, listener) => {
    events.off(event, listener);
    return bot;
  };
  const abort = new AbortController();
  const pending = hideInPlace(bot, {
    signal: abort.signal,
    recoverTo: 18,
    maximumMs: 1000,
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
  });
  abort.abort(new Error("hide cancelled"));
  await assert.rejects(pending, /hide cancelled/);
  assert.equal(events.listenerCount("physicsTick"), 0);
});

test("an intruder arriving during centering interrupts steering before construction", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? stone() : air()),
    items: [{ name: "cobblestone", count: 32 }],
    equipError: "placement boundary",
  });
  bot.entity.position.z = 0.146;
  const mob = closeMob("wither_skeleton");
  const on = bot.on;
  let introduced = false;
  bot.on = (event, listener) => {
    if (event === "physicsTick" && !introduced) {
      introduced = true;
      queueMicrotask(() => {
        bot.entities[2] = mob;
      });
    }
    return on.call(bot, event, listener);
  };
  bot.lookAt = async () => undefined;
  bot.attack = () => {
    delete bot.entities[2];
    bot.entity.position.z = 0.5;
  };
  const result = await hide(bot);
  assert.equal(result.swings, 1);
  assert.match(result.error ?? "", /placement boundary/);
});

test("crossing into the dug cell while airborne does not complete shaft descent", async () => {
  const bot = botIn({
    health: 20,
    blockAt: (position) => (position.y < 64 ? { ...(stone() as object), position, digTime: () => 750 } : air()),
  });
  let digs = 0;
  bot.dig = async () => {
    digs++;
    bot.entity.position.y = 63.2;
    bot.entity.onGround = false;
  };
  const result = await hide(bot);
  assert.equal(digs, 1);
  assert.equal(result.kind, "failed");
  assert.equal(result.capped, false);
  assert.match(result.error ?? "", /did not land/);
});

/**
 * Run 14 ended on a fortress walkway: the hide refused its first wall because
 * the cell beside the bot had no solid neighbour, stood down, and the next
 * fireball knocked the bot twenty-two blocks down. The block the bot stands
 * on always has a free side face there, so the floor is extended by one
 * before the wall goes up from it.
 */
test("a wall over a drop is built on a floor extension placed against the bot's own floor block", async () => {
  const result = await hide(
    botIn({
      health: 7,
      // A one-wide bridge: the only solid block is the one underfoot.
      blockAt: (position) => (position.x === 0 && position.y === 63 && position.z === 0 ? stone() : air()),
      items: [{ name: "cobblestone", count: 32 }],
      equipError: "placement boundary",
    }),
  );

  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /1,63,0/, "the extension cell beside the floor block, not the wall cell above it");
  assert.match(result.error ?? "", /cobblestone against stone face 1,0,0/, "placed against the floor block's side");
});

/**
 * The 2026-09-09 hold: two health, hunger thirteen, nothing to eat, and a
 * ninety-second wait in which the health bar could not move. The hold now says
 * so at once and hands the body back sealed in.
 */
test("a sealed-in bot with nothing to eat and hunger below the regeneration bar is held at once, and says why", async () => {
  const result = await hide(botIn({ health: 2, food: 13, blockAt: () => stone() }));

  assert.equal(result.kind, "held");
  assert.equal(result.enclosed, true);
  assert.equal(result.ate, null);
  assert.match(result.error ?? "", /no food, and hunger 13 is below the regeneration bar/);
});
