/**
 * The per-bot navigation runtime: one construction, one owner, one disposal.
 *
 * The session builds this once for a connected bot and hands the result to
 * whoever needs to move it. There is no registry and no lookup — if you hold a
 * runtime you have navigation, and if you do not, you cannot reach it.
 *
 * This is not the caller-facing boundary — `src/navigation/index.ts` is.
 */
import { ExecutionScope } from "../execution/execution-scope.js";
import { Diving } from "./diving.js";
import type { Bot } from "mineflayer";
import { cloudExposure, readDragonCloudHazards } from "../world/dragon-hazards.js";
import { breakBlockInPlace, type BreakBlockInPlace } from "./execution/in-place-break.js";
import { MineflayerBot, installNetherVinePhysics, mineflayerBotSurface } from "./mineflayer/bot.js";
import { createMineflayerMovementPolicy, type MineflayerMovementPolicyOptions } from "./mineflayer/movement-policy.js";
import { MineflayerWorldView } from "./mineflayer/world.js";
import type { WorldView } from "./world/world.js";
import type { MovementPolicy } from "./movements/policy.js";
import { runNavigation, type Navigate, type NavigationResult } from "./navigate.js";
import { createNavigator } from "./orchestration/navigator.js";
import type { StepFieldProvider } from "./step-field.js";
import type { NavigationEvent, TelemetrySink } from "./telemetry/index.js";

/**
 * Everything one connected bot's navigation offers.
 *
 * Route execution and in-place excavation share the same world and bot adapter.
 */
export interface NavigationRuntime extends AsyncDisposable {
  /** Remaining-air floor while navigation owns a verified dive, otherwise null. */
  diveBackstop?(): number | null;
  /** The world as navigation observes it, for callers that judge blocks the way routes do. */
  readonly world: WorldView;
  readonly navigate: Navigate;
  readonly breakBlockInPlace: BreakBlockInPlace;
  /**
   * Register the one provider every search asks for its step field.
   *
   * The session calls this once, from the one place that holds both this
   * runtime and whatever knows which cells are worth avoiding. Every route
   * then gets the field by default, and a route that must not have it passes
   * `stepField: null`.
   */
  setStepFieldProvider(provider: StepFieldProvider): void;
  /** Whether a route currently owns the bot. */
  readonly active: boolean;
  cancel(reason?: string): void;
  /** An admitted recovery owner will steer the airborne body after this route releases its controls. */
  releaseForTakeover(reason: string): void;
  onEvent(listener: (event: NavigationEvent) => void): () => void;
  close(): Promise<void>;
}

export function createMovements(bot: Bot, options?: MineflayerMovementPolicyOptions): MovementPolicy {
  return createMineflayerMovementPolicy(bot, options);
}

/** Build the navigation runtime for one connected Mineflayer bot. */
export function createNavigationRuntime(bot: Bot): NavigationRuntime {
  // Built in dependency order: the world view, the bot port over it, and the
  // navigator that looks at and acts on the bot through that port.
  const world = new MineflayerWorldView(bot);
  const diving = new Diving(bot, world, (state) => telemetry.emit({ kind: "dive", runId: "dive", atMs: Date.now(), state }));
  let selectedTool: ((itemType: number | null) => void) | undefined;
  const surface = mineflayerBotSurface(bot);
  const releaseNetherVinePhysics = installNetherVinePhysics(surface);
  const navigationBot = new MineflayerBot(surface, world, () => diving.owned, () => selectedTool);
  const listeners = new Set<(event: NavigationEvent) => void>();
  const telemetry: TelemetrySink = {
    emit(event) {
      if (event.kind === "route_committed") diving.committed(event.plan);
      for (const listener of [...listeners]) listener(event);
    },
    error(runId, cause) {
      process.stderr.write(
        `[mine-ai-mcp] Navigation run ${runId} failed internally: ${cause instanceof Error ? cause.stack || cause.message : String(cause)}\n`,
      );
    },
  };
  const navigator = createNavigator({ world, bot: navigationBot, telemetry });

  let activeRoute: Promise<NavigationResult> | null = null;
  let activeNavigation: Promise<NavigationResult> | null = null;
  let closed = false;

  const botDied = () => {
    diving.cancel("bot died");
    navigator.terminateActive("bot died");
  };
  bot.on("death", botDied);
  // Crossing a portal is a respawn into another dimension: every chunk
  // unloads and the position jumps, so a route in flight has nothing left
  // to stand on. Mineflayer already reports the new dimension by then.
  let dimension = bot.game.dimension;
  const botRespawned = () => {
    if (bot.game.dimension === dimension) return;
    diving.cancel("dimension changed");
    dimension = bot.game.dimension;
    navigator.terminateActive(`dimension changed to ${dimension}`);
  };
  bot.on("respawn", botRespawned);
  const botEnded = () => { diving.cancel("connection ended"); navigator.terminateActive("connection ended"); };
  bot.on("end", botEnded);

  const requireOpen = (): void => {
    if (closed) throw new Error("This navigation runtime is closed.");
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    diving.cancel("navigation runtime closed");
    navigator.terminateActive("navigation runtime closed");
    if (activeNavigation) await activeNavigation.catch(() => undefined);
    if (activeRoute) await activeRoute.catch(() => undefined);
    navigationBot.clearOwnedControls();
    bot.removeListener("death", botDied);
    bot.removeListener("respawn", botRespawned);
    bot.removeListener("end", botEnded);
    releaseNetherVinePhysics();
    world.close();
    listeners.clear();
  };

  const navigate: Navigate = async (options) => {
      using execution = new ExecutionScope({ bot: bot.username, operation: "navigation", targetId: null });
      using observations = new DisposableStack();
      const reportProgress = (event: NavigationEvent) => {
        switch (event.kind) {
          case "search_started":
            execution.progress("search", `${event.searchId}: ${event.reason}; goal=${event.goal}`);
            break;
          case "search_slice":
            execution.progress(
              "search",
              `${event.searchId}: visited=${event.visited}, generated=${event.generated}, computeMs=${event.computeMs}`,
            );
            break;
          case "step_started":
            execution.progress("movement", `${event.stepId}: ${event.movement}`);
            break;
          case "step_phase":
            execution.progress("movement", `${event.stepId}: ${event.phase}`);
            break;
        }
      };
      listeners.add(reportProgress);
      observations.defer(() => listeners.delete(reportProgress));
      const startedAt = Date.now();
      for (;;) {
        await execution.checkpoint(options.signal);
        requireOpen();
        // Goals and movement share the same fixed perch radius / eventual
        // fireball radius. Ordinary cloud growth must not cancel each step.
        const clouds = readDragonCloudHazards(bot);
        const start = bot.entity.position.floored().offset(0.5, 0, 0.5);
        const initialExposure = new Map(clouds.map((c) => [c.id, cloudExposure(c, start)]));
        const movements: MovementPolicy =
          clouds.length === 0
            ? options.movements
            : {
                ...options.movements,
                get scaffold() {
                  return options.movements.scaffold;
                },
                decideStep(x, y, z, view) {
                  const base = options.movements.decideStep(x, y, z, view);
                  if (base.kind === "prohibited") return base;
                  for (const cloud of clouds) {
                    if (cloudExposure(cloud, { x: x + 0.5, y, z: z + 0.5 }) > (initialExposure.get(cloud.id) ?? 0))
                      return { kind: "prohibited", reason: "Observed dragon breath occupies this step" };
                  }
                  return base;
                },
              };
        // Cloud appearance, removal, or growth changes safety without a block change. Rebuild
        // this same requested route after physical release, unless its caller
        // stopped it or a defensive takeover cancelled the action.
        const changed = new AbortController();
        const known = new Map(clouds.map((c) => [c.id, c.radius]));
        const watchClouds = () => {
          const current = readDragonCloudHazards(bot);
          if (current.length !== known.size || current.some((c) => known.get(c.id) !== c.radius))
            changed.abort("Dragon breath geometry changed");
        };
        bot.on("physicsTick", watchClouds);
        const route = execution.run("route", () =>
          runNavigation(navigator, {
            ...options,
            timeoutMs:
              options.timeoutMs === undefined ? undefined : Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
            movements,
            stopSignal: AbortSignal.any([changed.signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
          }),
        );
        activeRoute = route;
        try {
          const result = await route;
          if (
            result.status === "stopped" &&
            result.reason === "Dragon breath geometry changed" &&
            !closed &&
            !options.signal?.aborted &&
            !options.stopSignal?.aborted
          )
            continue;
          return { ...result, elapsedMs: Date.now() - startedAt };
        } finally {
          bot.off("physicsTick", watchClouds);
          if (activeRoute === route) activeRoute = null;
        }
      }
    };
  return {
    world,
    diveBackstop: () => diving.backstop(),
    navigate: async (options) => {
      requireOpen();
      if (activeNavigation) throw new Error("Navigation is busy with another request.");
      selectedTool = options.onToolSelected;
      const pending = diving.run(options, navigate);
      activeNavigation = pending;
      try { return await pending; }
      finally {
        if (activeNavigation === pending) activeNavigation = null;
        selectedTool = undefined;
      }
    },
    breakBlockInPlace: async (options) => {
      requireOpen();
      const block = world.blockAt(options.position.x, options.position.y, options.position.z);
      const evaluation = options.movements.evaluateBreak(block, options.position, world);
      const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
      const ticks = options.movements.digTimeEstimator.estimate(block, evaluation.tool, {
        submergedAtEyes: head?.name === "water", onGround: bot.entity.onGround,
        ...navigationBot.observe().player,
      });
      const refused = diving.beforeWork(ticks);
      if (refused !== null) {
        options.signal?.throwIfAborted();
        return { status: "failed", reason: refused };
      }
      const result = await breakBlockInPlace({ world, bot: navigationBot }, options);
      if (result.status === "broken") diving.workCompleted();
      return result;
    },
    setStepFieldProvider: (provider) => navigator.setStepFieldProvider(provider),
    get active() {
      return diving.active || navigator.active !== null;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel(reason = "cancelled") {
      diving.cancel(reason);
      navigator.cancelActive(reason);
    },
    releaseForTakeover(reason) {
      diving.cancel(reason);
      navigator.terminateActive(reason);
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
