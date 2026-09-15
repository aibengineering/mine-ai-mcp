import type { Bot, BotEvents } from "mineflayer";
import type { Position3 } from "../../utils/index.js";
import { StrongholdThrows } from "./throw-store.js";

const point = (p: Position3): Position3 => ({ x: p.x, y: p.y, z: p.z });

/**
 * One paid-for flight owns a passive observer until disappearance, disconnect,
 * or the acknowledgement deadline. Cancellation releases the body immediately;
 * it does not discard packets from an eye already in the air.
 */
function observeThrownEye(bot: Bot, store: StrongholdThrows): { promise: Promise<void>; close(): void } {
  const origin = point(bot.entity.position);
  const id = store.begin(origin);
  let close = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let flight: { uuid: string; entityId: number; start: Position3; end: Position3 } | null = null;
    let settled = false;
    // A vanilla eye lives 80 ticks (four seconds at 20 TPS). Ten seconds
    // allows packet/server lag, then preserves an incomplete observation
    // rather than retaining listeners indefinitely after a missing removal.
    const timer = setTimeout(() => finish("incomplete"), 10_000);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      bot.off("entitySpawn", spawn);
      bot.off("entityMoved", moved);
      bot.off("entityGone", gone);
      bot.off("end", ended);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const finish = (state: "observed" | "incomplete") => {
      if (settled) return;
      try {
        store.finish(id, state);
        cleanup();
        resolve();
      } catch (error) {
        fail(error);
      }
    };
    const spawn: BotEvents["entitySpawn"] = (entity) => {
      if (
        flight ||
        entity.name !== "eye_of_ender" ||
        !entity.uuid ||
        Math.hypot(entity.position.x - origin.x, entity.position.y - origin.y, entity.position.z - origin.z) > 3
      )
        return;
      const start = point(entity.position);
      flight = { uuid: entity.uuid, entityId: entity.id, start, end: start };
      try {
        store.observe(id, flight.uuid, start, start);
      } catch (error) {
        fail(error);
      }
    };
    const moved: BotEvents["entityMoved"] = (entity) => {
      if (!flight || entity.id !== flight.entityId || entity.uuid !== flight.uuid) return;
      flight.end = point(entity.position);
      try {
        store.observe(id, flight.uuid, flight.start, flight.end);
      } catch (error) {
        fail(error);
      }
    };
    const gone: BotEvents["entityGone"] = (entity) => {
      if (flight && entity.id === flight.entityId && entity.uuid === flight.uuid) finish("observed");
    };
    const ended = () => finish("incomplete");
    close = ended;
    bot.on("entitySpawn", spawn);
    bot.on("entityMoved", moved);
    bot.on("entityGone", gone);
    bot.on("end", ended);
    try {
      bot.activateItem();
    } catch (error) {
      fail(error);
    }
  });
  return { promise, close: () => close() };
}

/** Runtime-owned so a cancelled request can finish recording before SQLite closes. */
export class StrongholdEyeFlights implements Disposable {
  private flight: ReturnType<typeof observeThrownEye> | null = null;
  constructor(private readonly bot: Bot) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const flight = this.flight;
    if (!flight) return;
    try {
      await awaitFlight(flight.promise, signal);
    } finally {
      if (!signal?.aborted) this.flight = null;
    }
  }

  start(store: StrongholdThrows): void {
    if (this.flight) throw new Error("An Eye of Ender flight is still being observed.");
    this.flight = observeThrownEye(this.bot, store);
    // A cancelled caller may not return; retain the rejection for wait(),
    // while preventing an unhandled rejection during that idle interval.
    void this.flight.promise.catch(() => {});
  }

  [Symbol.dispose](): void {
    this.flight?.close();
    this.flight = null;
  }
}

/** Stop awaiting a passive flight when the foreground attempt is cancelled. */
export async function awaitFlight(flight: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([flight, cancelled]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
