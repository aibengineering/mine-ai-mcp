import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

type Entity = Bot["entity"];
type Flight = { entity: Entity; position: Vec3; velocity: Vec3; at: number; positionAt: number | null; velocityAt: number | null };
const trackers = new WeakMap<Bot, Map<number, Flight>>();
const ownership = new WeakMap<Bot, { users: number; close: () => void }>();
function lease(owner: { users: number; close: () => void }): Disposable {
  owner.users++;
  let released = false;
  return { [Symbol.dispose]() {
    if (released) return;
    released = true;
    if (--owner.users === 0) owner.close();
  } };
}
const arrow = (entity: Entity | undefined) => entity?.name === "arrow" || entity?.name === "spectral_arrow";
/** Vanilla's entity event for a shield block: the "shield blocks" sound on the blocking entity. */
const SHIELD_BLOCK_STATUS = 29;
/** Ticks between the server's hit and the client reading its status; extrapolation may lag or lead by that much. */
const BLOCK_CONFIRMATION_TICKS = 2;

/**
 * The tracked arrow the shield just stopped: the one whose estimated flight
 * reaches the body soonest, within the ticks a block confirmation can lag the
 * server's hit. The block packet names no arrow. A shot further out is not it.
 */
function arrowAtShield(bot: Bot, flights: Map<number, Flight>, at: number): Flight | null {
  const body = bot.entity;
  // The arrow's own box and vanilla's 0.3 hit inflation around the player's.
  const reach = (body.width ?? 0.6) / 2 + 0.55;
  let soonest: { flight: Flight; ticks: number } | null = null;
  for (const tracked of flights.values()) {
    if (!tracked.entity.isValid) continue;
    const flight = advance(bot, tracked, at);
    const { position, velocity } = flight;
    const speed = velocity.x * velocity.x + velocity.z * velocity.z;
    if (speed === 0) continue;
    const dx = body.position.x - position.x, dz = body.position.z - position.z;
    const ticks = (dx * velocity.x + dz * velocity.z) / speed;
    if (ticks < -1 || ticks > BLOCK_CONFIRMATION_TICKS) continue;
    const miss = Math.hypot(dx - velocity.x * ticks, dz - velocity.z * ticks);
    const height = position.y + velocity.y * Math.max(0, ticks) - body.position.y;
    if (miss > reach || height < -0.5 || height > (body.height ?? 1.8) + 0.5) continue;
    if (!soonest || ticks < soonest.ticks) soonest = { flight, ticks };
  }
  return soonest?.flight ?? null;
}

/** Advance only the estimate. Mineflayer's position remains the last packet observation. */
function advance(bot: Bot, flight: Flight, now: number): Flight {
  let { position, velocity, at } = flight;
  const ticks = Math.max(0, Math.floor((now - at) / 50));
  for (let tick = 0; tick < ticks && velocity.norm() > 0; tick++) {
    const speed = velocity.norm();
    if (bot.world.raycast(position, velocity.scaled(1 / speed), speed)) {
      velocity = velocity.scaled(0);
      break;
    }
    position = position.plus(velocity);
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
  return { ...flight, position, velocity, at: at + ticks * 50 };
}

export function arrowFlight(bot: Bot, entity: Entity, now = performance.now()) {
  const flight = trackers.get(bot)?.get(entity.id);
  return flight?.entity === entity ? advance(bot, flight, now) : {
    entity, position: entity.position.clone(), velocity: entity.velocity.clone(), at: now, positionAt: null, velocityAt: null,
  };
}

/** Owned by combat perception, not diagnostics. Packet handlers run after Mineflayer. */
export function trackArrowFlights(bot: Bot, now = () => performance.now()): Disposable {
  const existing = ownership.get(bot);
  if (existing) return lease(existing);
  const flights = new Map<number, Flight>();
  trackers.set(bot, flights);
  const anchor = (entity: Entity, observed = true) => {
    const at = now();
    flights.set(entity.id, { entity, position: entity.position.clone(), velocity: entity.velocity.clone(), at,
      positionAt: observed ? at : null, velocityAt: observed ? at : null });
  };
  for (const entity of Object.values(bot.entities)) if (arrow(entity)) anchor(entity, false);
  const names = ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"];
  const listeners = names.map((name) => {
    const listener = (packet: { entityId: number; entityIds?: number[]; dX?: number; dY?: number; dZ?: number }) => {
      if (name === "entity_destroy") {
        for (const id of packet.entityIds ?? []) flights.delete(id);
        return;
      }
      const entity = bot.entities[packet.entityId];
      if (!entity || !arrow(entity)) return;
      if (name === "spawn_entity" || name === "sync_entity_position" || !flights.has(entity.id)) {
        anchor(entity);
        return;
      }
      // A look-only relative packet is not a fresh flight position.
      if ((name === "rel_entity_move" || name === "entity_move_look") && !packet.dX && !packet.dY && !packet.dZ) return;
      const at = now();
      const estimate = advance(bot, flights.get(entity.id)!, at);
      flights.set(entity.id, name === "entity_velocity"
        ? { ...estimate, velocity: entity.velocity.clone(), at, velocityAt: at }
        : { ...estimate, position: entity.position.clone(), at, positionAt: at });
    };
    bot._client.on(name, listener);
    return { name, listener };
  });
  const blocked = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity?.id || packet.entityStatus !== SHIELD_BLOCK_STATUS) return;
    const deflected = arrowAtShield(bot, flights, now());
    if (deflected) flights.set(deflected.entity.id, { ...deflected, velocity: deflected.velocity.scaled(0) });
  };
  bot._client.on("entity_status", blocked);
  const clear = () => flights.clear();
  bot.on("respawn", clear);
  const owner = { users: 0, close() {
    bot._client.off("entity_status", blocked);
    for (const { name, listener } of listeners) bot._client.off(name, listener);
    bot.off("respawn", clear);
    trackers.delete(bot);
    ownership.delete(bot);
    flights.clear();
  } };
  ownership.set(bot, owner);
  return lease(owner);
}
