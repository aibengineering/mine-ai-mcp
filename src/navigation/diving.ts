import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { airSupplyTicks } from "../world/air-supply.js";
import { waitForPhysicsTicks } from "../utils/physics-ticks.js";
import { exactBlockGoal } from "./goals/index.js";
import type { Navigate, NavigateOptions } from "./navigate.js";
import type { MovementPolicy } from "./movements/policy.js";
import type { WorldView } from "./world/world.js";
import { DIVE_BACKSTOP_TICKS, DIVE_RESERVE_TICKS, openWaterSurface, swimTravelTicks } from "./world/swimming.js";
import type { RoutePlan } from "./movements/movement.js";

const BREATHING_STOP = "Planned breathing stop";
interface DiveSession {
  readonly cancelled: AbortController;
  owned: boolean;
  returning: boolean;
  stop: AbortController;
  completedWork: number;
}

/** Scoped declaration shared with survival; never a switch that removes the reflex. */
export class Diving {
  #session: DiveSession | null = null;
  readonly #read: WorldView["blockAt"];
  constructor(readonly bot: Bot, readonly world: WorldView,
    readonly report: (state: "breathing" | "resumed" | "released") => void = () => {}) {
    this.#read = (x, y, z) => world.blockAt(x, y, z);
  }
  get owned(): boolean { return this.#session?.owned === true; }
  get active(): boolean { return this.#session !== null; }
  cancel(reason: string): void { this.#session?.cancelled.abort(reason); }
  workCompleted(): void { if (this.#session) this.#session.completedWork++; }

  backstop(): number | null {
    const session = this.#session;
    if (!session?.owned) return null;
    if (this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0))?.name === "air") return DIVE_BACKSTOP_TICKS;
    const feet = this.bot.entity.position.floored();
    const surface = openWaterSurface(this.#read, feet);
    if (!surface) return 300; // The admission premise disappeared: request immediate rescue.
    return swimTravelTicks(this.bot.entity.position, surface) + DIVE_BACKSTOP_TICKS;
  }

  committed(plan: Pick<RoutePlan, "steps">): void {
    const session = this.#session;
    if (!session) return;
    if (plan.steps.some(({ to }) => this.world.blockAt(to.x, to.y + 1, to.z).kind === "loaded" &&
      this.bot.blockAt(new Vec3(to.x, to.y + 1, to.z))?.name === "water" && openWaterSurface(this.#read, to))) {
      session.owned = true;
    }
  }

  /** Long interactions ask before starting; an aborted route retains its original callback. */
  beforeWork(ticks: number): string | null {
    const session = this.#session;
    const feet = this.bot.entity.position.floored();
    if (this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0))?.name !== "water") return null;
    const surface = openWaterSurface(this.#read, feet);
    const air = airSupplyTicks(this.bot);
    if (!session?.owned || !surface || air === null || !this.bot.entity.onGround)
      return `Underwater stance unavailable at ${feet}: owned=${session?.owned === true}, escape=${!!surface}, air=${air}, grounded=${this.bot.entity.onGround}`;
    // A fresh dive must be able to finish this work, otherwise resurfacing would repeat forever.
    if (swimTravelTicks(surface, feet) + ticks + swimTravelTicks(feet, surface) + DIVE_RESERVE_TICKS > 300)
      return `Underwater work needs ${ticks} ticks at ${feet}; the full dive exceeds one breath`;
    if (ticks + swimTravelTicks(feet, surface) + DIVE_RESERVE_TICKS <= air) return null;
    session.stop.abort(BREATHING_STOP);
    return BREATHING_STOP;
  }

  async run(options: NavigateOptions, navigate: Navigate) {
    if (this.#session) throw new Error("Navigation already owns a dive session.");
    const session: DiveSession = { owned: false, returning: false, stop: new AbortController(),
      cancelled: new AbortController(), completedWork: 0 };
    this.#session = session;
    const lifetime = AbortSignal.any([session.cancelled.signal, ...(options.signal ? [options.signal] : [])]);
    options = { ...options, stopSignal: AbortSignal.any([session.cancelled.signal,
      ...(options.stopSignal ? [options.stopSignal] : [])]) };
    const started = Date.now();
    let previousStop = "";
    let repeatedStops = 0;
    const tick = () => {
      if (!session.owned || session.returning || session.stop.signal.aborted) return;
      const feet = this.bot.entity.position.floored();
      const surface = openWaterSurface(this.#read, feet);
      const air = airSupplyTicks(this.bot);
      // With a lost corridor the survival backstop must take over; do not call it a planned return.
      if (!surface) return;
      if (this.bot.blockAt(feet.offset(0, 1, 0))?.name === "water" &&
        (air === null || air <= swimTravelTicks(this.bot.entity.position, surface) + DIVE_RESERVE_TICKS))
        session.stop.abort(BREATHING_STOP);
    };
    this.bot.on("physicsTick", tick);
    try {
      // Servers omit unchanged default air metadata on login. Observe the first
      // shallow head immersion before admitting any dive; never invent full air.
      // This stays within one block of an already verified breathable surface.
      const initialSurface = openWaterSurface(this.#read, this.bot.entity.position.floored());
      if (options.movements.allowSwimming && airSupplyTicks(this.bot) === null && initialSurface &&
        this.bot.entity.position.y >= initialSurface.y - 0.5) {
        try {
          for (let ticks = 0; ticks < 80 && airSupplyTicks(this.bot) === null; ticks++) {
            options.signal?.throwIfAborted();
            if (options.stopSignal?.aborted) break;
            this.bot.setControlState("jump", this.bot.entity.position.y < initialSurface.y - 0.8);
            await waitForPhysicsTicks(this.bot, 1, lifetime);
          }
        } finally { this.bot.setControlState("jump", false); }
      }
      for (;;) {
        options.signal?.throwIfAborted();
        if (options.stopSignal?.aborted) return { status: "stopped" as const,
          reason: String(options.stopSignal.reason), elapsedMs: Date.now() - started };
        const air = airSupplyTicks(this.bot);
        const origin = this.bot.entity.position.clone();
        // A request beginning underwater must hold depth while its first search runs.
        session.owned = session.owned || (options.movements.allowSwimming && air !== null && openWaterSurface(this.#read, origin.floored()) !== null &&
          this.bot.blockAt(origin.offset(0, 1.62, 0))?.name === "water");
        const movements: MovementPolicy = { ...options.movements,
          get scaffold() { return options.movements.scaffold; },
          ...(air !== null && options.movements.allowSwimming ? { dive: { origin, airTicks: air } } : {}),
        };
        const result = await navigate({ ...options, movements,
          timeoutMs: options.timeoutMs === undefined ? undefined : Math.max(0, options.timeoutMs - (Date.now() - started)),
          stopSignal: AbortSignal.any([session.stop.signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
        });
        const continuingDive = session.stop.signal.aborted;
        const returnToProcess = options.onArrival !== undefined && session.owned &&
          this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0))?.name === "water";
        if ((!continuingDive && !returnToProcess) || session.cancelled.signal.aborted || options.signal?.aborted ||
          (options.stopSignal?.aborted && !returnToProcess)) return result;
        const surface = openWaterSurface(this.#read, this.bot.entity.position.floored());
        if (!surface) return { status: "stopped" as const, reason: "Dive lost its verified ascent corridor", elapsedMs: Date.now() - started };
        const progress = `${this.bot.entity.position.floored()}:${session.completedWork}`;
        repeatedStops = progress === previousStop ? repeatedStops + 1 : 0;
        previousStop = progress;
        if (repeatedStops >= 2) return { status: "stopped" as const, reason: "Dive cannot make progress within one breath", elapsedMs: Date.now() - started };
        session.returning = true;
        this.report("breathing");
        // A process's quantity signal ends its route, but still owes a safe
        // handoff. Action cancellation and defensive takeover always win.
        const returnStop = returnToProcess ? session.cancelled.signal : options.stopSignal;
        const returned = await navigate({ movements, goal: exactBlockGoal(surface), signal: options.signal,
          stopSignal: returnStop, timeoutMs: 15_000 });
        if (returned.status !== "completed") return returned;
        for (let ticks = 0; (airSupplyTicks(this.bot) ?? 0) < 300 && ticks < 100; ticks++) {
          options.signal?.throwIfAborted();
          if (returnStop?.aborted) return { status: "stopped" as const, reason: "Request stopped while breathing", elapsedMs: Date.now() - started };
          this.bot.setControlState("jump", true);
          await waitForPhysicsTicks(this.bot, 1, lifetime);
        }
        this.bot.setControlState("jump", false);
        if (airSupplyTicks(this.bot) !== 300) return { status: "stopped" as const, reason: "Full air was not observed at the breathing stop", elapsedMs: Date.now() - started };
        session.returning = false;
        session.stop = new AbortController();
        this.report("resumed");
        // A mining process may revise targets between navigation transactions.
        // Return its body with air, rather than exposing low air to the ordinary reflex in that gap.
        if (!continuingDive) return result;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (session.cancelled.signal.aborted) return { status: "stopped" as const,
        reason: String(session.cancelled.signal.reason), elapsedMs: Date.now() - started };
      throw error;
    } finally {
      this.bot.off("physicsTick", tick);
      if (session.returning) this.bot.setControlState("jump", false);
      this.#session = null;
      if (session.owned) this.report("released");
    }
  }
}
