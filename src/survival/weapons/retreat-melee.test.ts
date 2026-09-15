import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { HostileContext } from "../control/combat/context.js";
import { defendWhileRetreating } from "./retreat-melee.js";

function fixture() {
  const registry = minecraftData("1.21.4");
  const metadata: unknown[] = [];
  metadata[registry.entitiesByName.magma_cube!.metadataKeys!.indexOf("size")] = 2;
  const target = {
    id: 7,
    name: "magma_cube",
    kind: "Hostile mobs",
    isValid: true,
    width: 1.04,
    height: 1.04,
    metadata: metadata as Parameters<Bot["attack"]>[0]["metadata"],
    position: new Vec3(2, 64, 0),
  };
  const attacks: number[] = [];
  let ticks = 0;
  let covered = false;
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: { 7: target },
    registry,
    health: 11,
    heldItem: { name: "diamond_sword" },
    targetDigBlock: null,
    usingHeldItem: false,
    world: { raycast: () => (covered ? {} : null) },
    attack: () => {
      attacks.push(ticks);
    },
    // No equip/look/control methods: retreat defence must not steal these
    // operations from the route that is already using them.
  }) as unknown as Bot;
  const resolvedIds = new Set<number>();
  const context: HostileContext = {
    resolvedIds,
    attackerIds: new Set(),
    unreachableIds: new Set(),
  };
  const advance = (count = 1) => {
    for (let i = 0; i < count; i++) {
      ticks += 1;
      bot.emit("physicsTick");
    }
  };
  return {
    bot,
    target,
    context,
    resolvedIds,
    attacks,
    advance,
    cover: (value: boolean) => {
      covered = value;
    },
  };
}

test("retreat strikes respect sword cooldown, observed death, and observer disposal without steering", () => {
  const f = fixture();
  const defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  f.advance(14);
  assert.deepEqual(f.attacks, [1, 14]);
  // The hostile observer owns the shared record of dead threats.
  f.resolvedIds.add(f.target.id);
  f.bot.emit("entityDead", f.target as Parameters<Bot["attack"]>[0]);
  f.advance(20);
  assert.deepEqual(defence.evidence(), { attacks: 2, weaponsUsed: ["diamond_sword"], killedTargetIds: [7] });
  defence[Symbol.dispose]();
  assert.equal(f.bot.listenerCount("physicsTick"), 0);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
});

test("retreat does not strike through cover, beyond reach, during a dig, or after cancellation", () => {
  const f = fixture();
  const controller = new AbortController();
  using defence = defendWhileRetreating(f.bot, f.context, controller.signal);
  f.cover(true);
  f.advance();
  f.cover(false);
  f.target.position.x = 4;
  f.advance();
  f.target.position.x = 2;
  f.bot.targetDigBlock = {} as NonNullable<Bot["targetDigBlock"]>;
  f.advance();
  Object.assign(f.bot, { targetDigBlock: null });
  f.bot.usingHeldItem = true;
  f.advance();
  f.bot.usingHeldItem = false;
  assert.deepEqual(f.attacks, []);
  f.advance();
  assert.deepEqual(f.attacks, [5]);
  controller.abort();
  f.advance(20);
  assert.deepEqual(f.attacks, [5]);
  assert.equal(defence.evidence().attacks, 1);
});

test("retreat preserves nearby neutrals from sword sweep and never selects them as targets", () => {
  const f = fixture();
  const neutral = { ...f.target, id: 8, name: "piglin", position: new Vec3(1, 64, 1) };
  f.bot.entities[8] = neutral as Parameters<Bot["attack"]>[0];
  using defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  f.advance();
  assert.deepEqual(f.attacks, []);
  neutral.position.x = 10;
  f.advance();
  assert.deepEqual(f.attacks, [2]);
  delete f.bot.entities[7];
  neutral.position.x = 1;
  f.advance(20);
  assert.deepEqual(f.attacks, [2]);
  assert.equal(defence.evidence().attacks, 1);
});
