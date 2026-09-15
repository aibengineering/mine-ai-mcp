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
  const clear = () => flights.clear();
  bot.on("respawn", clear);
  const owner = { users: 0, close() {
    for (const { name, listener } of listeners) bot._client.off(name, listener);
    bot.off("respawn", clear);
    trackers.delete(bot);
    ownership.delete(bot);
    flights.clear();
  } };
  ownership.set(bot, owner);
  return lease(owner);
}
