import type { Bot } from "mineflayer";
import { z } from "zod";
import type { IncidentRecorder } from "./incident-recorder.js";

const rotation = z.object({ yaw: z.number(), pitch: z.number() });
const outgoing: Record<string, z.ZodType> = {
  use_item: z.object({ hand: z.number(), sequence: z.number(), rotation: z.object({ x: z.number(), y: z.number() }) }),
  block_dig: z.object({ status: z.literal(5), sequence: z.number().optional() }),
  look: rotation,
  position_look: rotation.extend({ x: z.number(), y: z.number(), z: z.number() }),
  held_item_slot: z.object({ slotId: z.number() }),
  arm_animation: z.object({ hand: z.number() }),
  entity_action: z.object({ entityId: z.number(), actionId: z.number() }),
};

/** Observe protocol writes, never change them. A returned write is not server acknowledgement. */
export function observeCombatPackets(bot: Bot, recorder: IncidentRecorder, flagsIndex: number) {
  let order = 0;
  type Command = { atMs: number; order: number; packet: string; fields: unknown };
  let lastUse: Command | null = null;
  let lastRotation: Command | null = null;
  let active = true;
  let lastFlags: { atMs: number; order: number; value: number } | null = null;
  const record = (direction: "outgoing" | "incoming", packet: string, fields: unknown, outcome?: string) => {
    const atMs = Date.now();
    const entry = { atMs, order: ++order, packet, fields };
    recorder.record("packet", { direction, order: entry.order, packet, fields, ...(outcome ? { outcome } : {}) }, atMs);
    return entry;
  };
  const client = bot._client;
  // Observe the assignment itself: an event listener runs too late to identify
  // which Mineflayer callback cleared the flag. Preserve its data-property semantics.
  const descriptor = Object.getOwnPropertyDescriptor(bot, "usingHeldItem");
  let using = bot.usingHeldItem;
  const getUsing = () => using;
  const setUsing = (value: boolean) => {
    const before = using;
    using = value;
    if (active && before !== value) record("incoming", "item_use_transition", {
      before, after: value, origin: "local_assignment",
      stack: new Error().stack?.split("\n").slice(2, 9),
      mainHand: bot.heldItem?.name ?? null, offHand: bot.inventory?.slots?.[45]?.name ?? null,
    });
  };
  if (descriptor?.configurable && "value" in descriptor && descriptor.writable)
    Object.defineProperty(bot, "usingHeldItem", { configurable: true, enumerable: descriptor.enumerable, get: getUsing, set: setUsing });
  const heldChanged = () => { record("incoming", "held_item_changed", {
    mainHand: bot.heldItem?.name ?? null, count: bot.heldItem?.count ?? null,
    offHand: bot.inventory?.slots?.[45]?.name ?? null, usingHeldItem: bot.usingHeldItem,
  }); };
  bot.on("heldItemChanged", heldChanged);
  const originalWrite = client.write;
  const write: typeof client.write = function (this: typeof client, name, params) {
    if (!active) return originalWrite.call(this, name, params);
    const schema = outgoing[name];
    // Other digging actions are already represented by navigation events.
    const parsed = name === "block_dig" && Reflect.get(params, "status") !== 5
      ? null : schema?.safeParse(params);
    const entry = parsed?.success ? record("outgoing", name, parsed.data, "write_requested") : null;
    if (parsed && !parsed.success)
      recorder.record("packet_unavailable", { direction: "outgoing", packet: name, reason: "unsupported diagnostic fields" });
    try {
      const result = originalWrite.call(this, name, params);
      if (entry && (name === "use_item" || name === "block_dig" || name === "held_item_slot")) lastUse = entry;
      if (entry && (name === "look" || name === "position_look" || name === "use_item")) lastRotation = entry;
      return result;
    } catch (error) {
      if (entry) recorder.record("packet", { direction: "outgoing", order: ++order, packet: name, writeOrder: entry.order, outcome: "write_threw" });
      throw error;
    }
  };
  // Lightweight test bots may not implement a protocol writer.
  if (typeof originalWrite === "function") client.write = write;
  const metadata = (raw: unknown) => {
    const parsed = z.object({ entityId: z.number(), metadata: z.array(z.object({ key: z.number(), value: z.unknown() })) }).safeParse(raw);
    if (!parsed.success || parsed.data.entityId !== bot.entity.id) return;
    const flags = parsed.data.metadata.find((entry) => entry.key === flagsIndex);
    if (!flags) return;
    if (typeof flags.value !== "number") {
      recorder.record("packet_unavailable", { direction: "incoming", packet: "entity_metadata", reason: "unsupported living entity flags" });
      return;
    }
    const entry = record("incoming", "entity_metadata", { entityId: parsed.data.entityId, key: flagsIndex, value: flags.value });
    lastFlags = { atMs: entry.atMs, order: entry.order, value: flags.value };
  };
  const status = (raw: unknown) => {
    const parsed = z.object({ entityId: z.number(), entityStatus: z.number() }).safeParse(raw);
    if (parsed.success && parsed.data.entityId === bot.entity.id) record("incoming", "entity_status", parsed.data);
  };
  const cooldown = (raw: unknown) => {
    const parsed = z.object({ cooldownGroup: z.string(), cooldownTicks: z.number() }).safeParse(raw);
    if (parsed.success) record("incoming", "set_cooldown", parsed.data);
  };
  const reset = () => { lastUse = null; lastRotation = null; lastFlags = null; };
  client.on("entity_metadata", metadata);
  client.on("entity_status", status);
  client.on("set_cooldown", cooldown);
  bot.on("respawn", reset);
  return {
    snapshot: () => ({
      lastItemCommand: lastUse,
      lastRotationCommand: lastRotation,
      lastReceivedUseFlags: lastFlags,
      useFlagsAgeMs: lastFlags ? Date.now() - lastFlags.atMs : null,
      // Protocol metadata is a last observation, not a per-hit server verdict.
      serverBlockingConfirmed: false,
    }),
    [Symbol.dispose]() {
      active = false;
      if (Object.getOwnPropertyDescriptor(bot, "usingHeldItem")?.get === getUsing)
        Object.defineProperty(bot, "usingHeldItem", { ...descriptor, value: using });
      bot.off("heldItemChanged", heldChanged);
      if (client.write === write) client.write = originalWrite;
      client.off("entity_metadata", metadata);
      client.off("entity_status", status);
      client.off("set_cooldown", cooldown);
      bot.off("respawn", reset);
    },
  };
}
