import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { readEncounters } from "../combat/reflex.ts";

const position = z.tuple([z.number(), z.number(), z.number()]);
const paramsSchema = z.strictObject({
  mob: z.enum(["zombie", "skeleton"]),
  spawns: z.array(position).min(1),
  destination: position,
  deckY: z.number(),
  lavaY: z.number(),
});

/** Native attacks must occur at the hazard, followed by an ordinary completed route. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params);
  if (!(await standStill(context))) return { status: "failed", detail: "Player did not settle." };
  const started = Date.now();
  let deaths = 0;
  let damage = 0;
  let lastHealth = bot.health;
  let minimumHealth = bot.health;
  let minimumY = bot.entity.position.y;
  let enteredLava = false;
  let bodyOverlappedLavaCell = false;
  let shieldBlocks = 0;
  let arrows = 0;
  let followingTicks = 0;
  const contacts: unknown[] = [];
  const damagePackets: unknown[] = [];
  const velocities: unknown[] = [];
  const history: unknown[] = [];
  const followingContactTicks: unknown[] = [];
  const inLava = () =>
    Reflect.get(bot.entity, "isInLava") === true || bot.blockAt(bot.entity.position)?.name === "lava";
  // This is a conservative full-body/source-cell witness, separate from native contracted fluid physics.
  // ceil(max)-1 excludes a block touched only at the body boundary, including lava below a dry shore.
  const overlapsLavaCell = () => {
    const feet = bot.entity.position;
    const halfWidth = bot.entity.width / 2;
    for (let x = Math.floor(feet.x - halfWidth); x < Math.ceil(feet.x + halfWidth); x++) {
      for (let y = Math.floor(feet.y); y < Math.ceil(feet.y + bot.entity.height); y++) {
        for (let zPosition = Math.floor(feet.z - halfWidth); zPosition < Math.ceil(feet.z + halfWidth); zPosition++) {
          if (bot.blockAt(new Vec3(x, y, zPosition))?.name === "lava") return true;
        }
      }
    }
    return false;
  };
  if (bot.health !== 20 || inLava() || overlapsLavaCell() || !bot.entity.onGround) {
    return {
      status: "failed",
      detail: `Invalid initial arrangement: health=${bot.health}, lava=${inLava()}, grounded=${bot.entity.onGround}.`,
    };
  }
  const frame = () => ({
    ms: Date.now() - started,
    position: bot.entity.position.clone(),
    velocity: bot.entity.velocity.clone(),
    onGround: bot.entity.onGround,
    inLava: inLava(),
    bodyOverlapsLavaCell: overlapsLavaCell(),
    health: bot.health,
  });
  const footing = () => {
    const feet = bot.entity.position;
    const halfWidth = bot.entity.width / 2;
    const support = [-halfWidth, halfWidth].flatMap((x) =>
      [-halfWidth, halfWidth].map((zPosition) => {
        const point = feet.offset(x, -0.1, zPosition).floored();
        return { position: point, block: bot.blockAt(point)?.name ?? null };
      }),
    );
    const lava = [-1, 0, 1]
      .flatMap((x) =>
        [-1, 0, 1].map((zPosition) => new Vec3(Math.floor(feet.x) + x, params.lavaY, Math.floor(feet.z) + zPosition)),
      )
      .filter((point) => bot.blockAt(point)?.name === "lava")
      .sort((left, right) => left.distanceTo(feet) - right.distanceTo(feet))[0];
    return { support, nearestObservedLava: lava ?? null, lavaDistance: lava?.distanceTo(feet) ?? null };
  };
  const contact = (kind: string, source: number | null) => {
    const event = { kind, source, ...frame(), ...footing(), precedingTicks: [...history] };
    contacts.push(event);
    log(`CONTACT ${JSON.stringify(event)}`);
    followingTicks = 10;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source?.name === params.mob) contact("native_damage", source.id);
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) {
      shieldBlocks++;
      contact("native_shield_block", null);
    }
  };
  const health = () => {
    damage += Math.max(0, lastHealth - bot.health);
    lastHealth = bot.health;
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  const packetDamage = (packet: { entityId: number }) => {
    if (packet.entityId === bot.entity.id) damagePackets.push(packet);
  };
  const velocity = (packet: { entityId: number }) => {
    if (packet.entityId === bot.entity.id) velocities.push({ ...frame(), packet });
  };
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name !== "arrow") return;
    arrows++;
    // A missed incoming arrow is still native attack pressure. Requiring a
    // hit or shield block rejected successful ranged defense on the bridge.
    const eyes = bot.entity.position.offset(0, bot.entity.height * 0.85, 0);
    const attacker = Object.values(bot.entities).find(
      (candidate) =>
        candidate.name === "skeleton" &&
        candidate.isValid &&
        candidate.position.offset(0, candidate.height * 0.85, 0).distanceTo(entity.position) < 2,
    );
    if (attacker && entity.position.distanceTo(eyes) > 2) contact("native_arrow", attacker.id);
  };
  const tick = () => {
    minimumY = Math.min(minimumY, bot.entity.position.y);
    enteredLava ||= inLava();
    bodyOverlappedLavaCell ||= overlapsLavaCell();
    const current = frame();
    // Half a second on each side of native contact records the physical displacement without a full replay.
    history.push(current);
    if (history.length > 10) history.shift();
    if (followingTicks-- > 0) {
      followingContactTicks.push(current);
      log(`AFTER_CONTACT ${JSON.stringify(current)}`);
    }
  };
  bot.on("entityHurt", hurt);
  bot.on("health", health);
  bot.on("death", death);
  bot.on("physicsTick", tick);
  bot.on("entitySpawn", spawn);
  bot._client.on("entity_status", status);
  bot._client.on("damage_event", packetDamage);
  bot._client.on("entity_velocity", velocity);
  const snapshot = () => ({
    deaths,
    health: bot.health,
    minimumHealth,
    damage,
    minimumY,
    enteredLava,
    bodyOverlappedLavaCell,
    shieldBlocks,
    arrows,
    armor: [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? null),
    position: bot.entity.position,
    contacts,
    damagePackets,
    velocities,
    followingContactTicks,
  });
  try {
    const hand = params.mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
    for (const [sx, sy, sz] of params.spawns) {
      bot.chat(`/summon minecraft:${params.mob} ${sx} ${sy} ${sz} {PersistenceRequired:1b${hand}}`);
    }
    while (Object.values(bot.entities).filter((entity) => entity.name === params.mob).length < params.spawns.length) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    // No further arrangement commands occur: every attack, block and movement is native/runtime-owned.
    const runtime = await openRuntime(context, "combat-terrain");
    try {
      const navigate = runtime.actions.find((action) => action.name === NAVIGATE)!;
      const [x, y, zPosition] = params.destination;
      const request = { x, y, z: zPosition, range: 1 };
      const first = await runtime.run(navigate, request, signal);
      log(`ROUTE ${JSON.stringify(first)}`);
      const encounters = await readEncounters(context, runtime);
      const arrived = bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zPosition + 0.5)) <= 2;
      const routeStatus = first.result.status;
      return {
        status:
          deaths === 0 &&
          bot.health > 0 &&
          !enteredLava &&
          !bodyOverlappedLavaCell &&
          minimumY >= params.deckY - 0.5 &&
          arrived &&
          routeStatus === "succeeded"
            ? "succeeded"
            : "failed",
        detail: JSON.stringify({ ...snapshot(), arrived, routeStatus, encounters }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    log(`FINAL ${JSON.stringify(snapshot())}`);
    bot.off("entityHurt", hurt);
    bot.off("health", health);
    bot.off("death", death);
    bot.off("physicsTick", tick);
    bot.off("entitySpawn", spawn);
    bot._client.off("entity_status", status);
    bot._client.off("damage_event", packetDamage);
    bot._client.off("entity_velocity", velocity);
  }
};
