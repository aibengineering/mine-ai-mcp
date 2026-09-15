import type { Bot } from "mineflayer";
import type { IncidentRecorder } from "../../src/diagnostics/incident-recorder.js";

const vector = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });
const isArrow = (entity: Bot["entity"] | undefined) => entity?.name === "arrow" || entity?.name === "spectral_arrow";

/** Passive arrow-only evidence: protocol observations remain distinct from prediction. */
export function observeProjectilePackets(bot: Bot, recorder: IncidentRecorder) {
  const tracked = new Set<number>(Object.values(bot.entities).filter(isArrow).map((entity) => entity.id));
  const names = ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look",
    "entity_teleport", "sync_entity_position", "entity_metadata", "entity_destroy"];
  const handlers = names.map((packet) => {
    // Installed after Mineflayer's entity plugin, so this captures its applied state.
    const handler = (raw: Record<string, any>) => {
      const ids: number[] = packet === "entity_destroy" ? raw.entityIds : [raw.entityId];
      for (const id of ids ?? []) {
        const entity = bot.entities[id];
        if (!isArrow(entity) && !tracked.has(id)) continue;
        const atMs = Date.now();
        tracked.add(id);
        const fields = Object.fromEntries(["entityId", "type", "x", "y", "z", "dX", "dY", "dZ", "dx", "dy", "dz", "yaw", "pitch", "velocity", "metadata"]
          .filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
        recorder.record("packet", { direction: "incoming", packet, projectileId: id, fields,
          applied: entity ? { position: vector(entity.position), velocity: vector(entity.velocity), isValid: entity.isValid } : null,
        }, atMs);
        if (packet === "entity_destroy") tracked.delete(id);
      }
    };
    bot._client.on(packet, handler);
    return { packet, handler };
  });
  const reset = () => tracked.clear();
  bot.on("respawn", reset);
  return {
    [Symbol.dispose]() {
      for (const { packet, handler } of handlers) bot._client.off(packet, handler);
      bot.off("respawn", reset);
      tracked.clear();
    },
  };
}
