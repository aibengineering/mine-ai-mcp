import type { BlockHighlighter } from "@aibengineering/minecraft-block-highlighter";
import type { Bot } from "mineflayer";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Action, ActionOutput, ActionResult } from "../actions/index.js";
import { actionSqlQueries, createActions, StrongholdEyeFlights } from "../actions/index.js";
import { AsyncActions, ExecutionStore } from "../session/async-actions.js";
import {
  readRequestIncidents,
  recordIncident,
  type IncidentReference,
  type IncidentRetention,
} from "../bot-data/incident-log.js";
import {
  installActionQueryCatalog,
  installMinecraftKnowledge,
  readNotificationSummary,
  recordActionRequest,
  recordActionResponse,
  SqlBotData,
  type ActionCallStatus,
  type ActionRequestInput,
  type ActionResponseInput,
  type BotDataScopeKind,
  type NotificationSummary,
  type SqlBotDataOptions,
} from "../bot-data/index.js";
import { observeIncidents } from "../diagnostics/incident-observer.js";
import { INCIDENT_HISTORY_MS, type IncidentProvenance } from "../diagnostics/incident-recorder.js";
import { ExecutionScope, observeExecution } from "../execution/execution-scope.js";
import { createNavigationRuntime, type NavigationRuntime } from "../navigation/index.js";
import type { StepFieldProvider } from "../navigation/step-field.js";
import { ActionRunner, type ActionRunnerStatus } from "../session/action-runner.js";
import { attachIdleWaterControl } from "../survival/baseline/idle-water.js";
import { ReflexDriver } from "../survival/control/driver.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import { attachSurvivalReceipts } from "../survival/evidence/receipts.js";
import { SurvivalObserver } from "../survival/evidence/status.js";
import { attachEndermanGazeControl } from "../survival/guards/enderman-gaze.js";
import { createCombatController, createHostileStepFieldProvider, type CombatController } from "../survival/index.js";
import { CombatPerception } from "../survival/perception/combat/observations.js";
import { attachBreathReflex } from "../survival/reflexes/breath.js";
import { attachDragonReflex } from "../survival/reflexes/dragon.js";
import { attachFireReflex } from "../survival/reflexes/fire.js";
import { attachFootingReflex } from "../survival/reflexes/footing.js";
import { guardFooting } from "../survival/weapons/footing-guard.js";
import { attachHostileReflex } from "../survival/reflexes/hostile.js";
import { attachHungerReflex } from "../survival/reflexes/hunger.js";
import { FootingRecovery } from "../survival/responses/footing.js";
import { attachSessionFrontier, type SessionFrontier, type SessionFrontierStatus } from "./frontier.js";
import { observeEquipmentEvents } from "./equipment-events.js";
import { observeCombatResourceEvents } from "./combat-resource-events.js";
import { observeReflexActivity } from "./reflex-activity.js";
import { observeBotStatus } from "./bot-status.js";
import { observePlayerEvents } from "./player-events.js";
import { snapshotTools } from "../world/tool-tiers.js";

export interface MinecraftRuntimeOptions {
  readonly botData: SqlBotDataOptions;
  readonly highlighter?: BlockHighlighter;
  readonly debugExecuteJavaScript?: boolean;
  readonly onDisconnect?: (reason: string) => void;
  /** A replacement receives the same perception, footing and budgets as every reflex. */
  readonly createCombatController?: typeof createCombatController;
  /** Optional field replacement for controlled navigation comparisons. */
  readonly stepFieldProvider?: StepFieldProvider;
  /** The host supplies process/source identity; scenario callers may select their artifact directory. */
  readonly incidents?: {
    readonly directory?: string;
    readonly provenance?: IncidentProvenance;
    readonly retention?: IncidentRetention;
  };
}

type RuntimeRun = <Name extends string, Request, Result extends ActionResult>(
  definition: Action<Name, Request, Result>,
  input: unknown,
  signal?: AbortSignal,
  requestId?: number,
  actionId?: string,
) => Promise<ActionOutput<Name, Result>>;

export interface MinecraftRuntimeStatus extends ActionRunnerStatus {
  readonly foreground: ReturnType<AsyncActions["status"]>;
  readonly survival: SurvivalStatus;
  readonly combat: { targetId: number; execution: ReturnType<CombatController["execution"]> } | null;
  readonly survivalPolicy: import("../survival/policy/contract.js").PolicySnapshot;
  readonly incidents: ReturnType<ReturnType<typeof observeIncidents>["status"]>;
  readonly frontier: SessionFrontierStatus;
  readonly botData: {
    readonly persistence: "persistent" | "temporary";
    readonly scope: BotDataScopeKind;
    readonly file: string | null;
    readonly diagnostics: ReturnType<SqlBotData["diagnostics"]>;
  };
}

export interface MinecraftRuntime extends AsyncDisposable {
  readonly asyncActions: AsyncActions;
  readonly actions: ReturnType<typeof createActions>;
  readonly run: RuntimeRun;
  readRequestIncidents(requestId: number): IncidentReference[];
  captureIncident(): ReturnType<ReturnType<typeof observeIncidents>["capture"]>;
  /** Developer/scenario synchronization; normal MCP replies never wait on diagnostic I/O. */
  flushIncidents(): Promise<void>;
  /** Observe navigation without acquiring its physical controls. */
  readonly navigation: Pick<NavigationRuntime, "onEvent">;
  notificationSummary(): NotificationSummary;
  recordActionRequest(request: ActionRequestInput): number;
  recordActionResponse(response: ActionResponseInput): void;
  /** The newest MCP calls, newest first, so an observer polling /health can show what the bot was asked and why. */
  recentCalls(): ActionCall[];
  status(): MinecraftRuntimeStatus;
  disconnect(reason: string): void;
  close(): Promise<void>;
}

/**
 * How many calls the runtime keeps for observers. Enough to read the run-up to
 * whatever is on screen; a session's full history belongs to the call log.
 */
const RECENT_CALL_LIMIT = 8;

export interface ActionCall {
  readonly requestId: number;
  readonly action: string;
  /** The call's own arguments, without the rationale and response format every call carries. */
  readonly arguments: Record<string, unknown>;
  readonly rationale: string;
  readonly requestedAt: string;
  readonly status: ActionCallStatus | null;
  readonly respondedAt: string | null;
  readonly durationMs: number | null;
}

class AttachedMinecraftRuntime implements MinecraftRuntime {
  readonly asyncActions: AsyncActions;
  readonly actions: ReturnType<typeof createActions>;
  readonly run: RuntimeRun;
  readonly navigation: Pick<NavigationRuntime, "onEvent">;

  readonly #bot: Bot;
  readonly #botData: SqlBotData;
  readonly #botDataScope: BotDataScopeKind;
  readonly #frontier: SessionFrontier;
  readonly #runner: ActionRunner;
  readonly #resources: AsyncDisposableStack;
  #closePromise: Promise<void> | undefined;
  /** Newest first, at most RECENT_CALL_LIMIT entries. */
  #recentCalls: ActionCall[] = [];

  constructor(
    bot: Bot,
    botData: SqlBotData,
    botDataScope: BotDataScopeKind,
    frontier: SessionFrontier,
    runner: ActionRunner,
    actions: ReturnType<typeof createActions>,
    navigation: NavigationRuntime,
    resources: AsyncDisposableStack,
    private readonly incidents: ReturnType<typeof observeIncidents>,
    private readonly policy: import("../survival/state/survival-policy.js").SurvivalPolicyState,
    private readonly connectionLost: (reason: string) => void,
    private readonly combat: CombatController,
    private readonly survival: SurvivalObserver,
  ) {
    this.#bot = bot;
    this.#botData = botData;
    this.#botDataScope = botDataScope;
    this.#frontier = frontier;
    this.#runner = runner;
    this.#resources = resources;
    this.actions = actions;
    this.navigation = { onEvent: navigation.onEvent };
    this.run = async (definition, input, signal, requestId, actionId) => {
      incidents.recorder.record("request_started", { requestId: requestId ?? null, action: definition.name });
      using execution = new ExecutionScope({
        bot: bot.username,
        operation: definition.name,
        targetId: null,
        requestId: requestId ?? null,
        ...(actionId ? { actionId } : {}),
      });
      const output = await execution.run("execute", () => runner.run(definition, input, signal, requestId, actionId));
      incidents.recorder.record("request_settled", {
        requestId: requestId ?? null,
        action: definition.name,
        status: output.result.status,
        interruptions: output.interruptions ?? [],
      });
      const status = survival.snapshot();
      return {
        ...output,
        survivalPolicy: policy.snapshot(),
        survival: { ...status, request: output.request ?? status.request },
      };
    };
    this.asyncActions = new AsyncActions(runner, this.run, new ExecutionStore(botData, bot.username));
  }

  readRequestIncidents(requestId: number): IncidentReference[] {
    return readRequestIncidents(this.#botData, requestId);
  }

  captureIncident(): ReturnType<ReturnType<typeof observeIncidents>["capture"]> {
    if (this.#closePromise) return Promise.resolve({ kind: "failed", error: "The Minecraft runtime is closed." });
    return this.incidents.capture();
  }

  flushIncidents(): Promise<void> {
    return this.incidents.recorder.flush();
  }

  notificationSummary(): NotificationSummary {
    return readNotificationSummary(this.#botData, this.#bot.username);
  }

  recordActionRequest(request: ActionRequestInput): number {
    const requestId = recordActionRequest(this.#botData, this.#bot.username, request);
    const raw = typeof request.request === "object" && request.request !== null ? request.request : {};
    const callArguments = Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "rationale" && key !== "response_format"),
    );
    this.#recentCalls.unshift({
      requestId,
      action: request.actionName,
      arguments: callArguments,
      rationale: request.rationale,
      requestedAt: request.requestedAt,
      status: null,
      respondedAt: null,
      durationMs: null,
    });
    this.#recentCalls.length = Math.min(this.#recentCalls.length, RECENT_CALL_LIMIT);
    return requestId;
  }

  recordActionResponse(response: ActionResponseInput): void {
    recordActionResponse(this.#botData, response);
    const index = this.#recentCalls.findIndex((call) => call.requestId === response.requestId);
    if (index === -1) return;
    this.#recentCalls[index] = {
      ...this.#recentCalls[index]!,
      status: response.status,
      respondedAt: response.respondedAt,
      durationMs: response.durationMs,
    };
  }

  recentCalls(): ActionCall[] {
    return [...this.#recentCalls];
  }

  status(): MinecraftRuntimeStatus {
    return {
      ...this.#runner.status(),
      foreground: this.asyncActions.status(),
      survival: this.survival.snapshot(),
      combat: this.combat.activeEngagement()
        ? { targetId: this.combat.activeEngagement()!.targetId, execution: this.combat.execution() }
        : null,
      survivalPolicy: this.policy.snapshot(),
      frontier: this.#frontier.status(),
      incidents: this.incidents.status(),
      botData: {
        persistence: this.#botData.location.kind,
        scope: this.#botDataScope,
        file: this.#botData.location.kind === "persistent" ? this.#botData.location.file : null,
        diagnostics: this.#botData.diagnostics(),
      },
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#stopEverything();
    return this.#closePromise;
  }

  disconnect(reason: string): void {
    this.connectionLost(reason);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #stopEverything(): Promise<void> {
    this.#runner.disconnect("Minecraft runtime closed");
    await this.asyncActions.settled();
    await this.#resources.disposeAsync();
  }
}

/** Own every long-lived facility attached to one connected Minecraft bot. */
export async function createMinecraftRuntime(
  bot: Bot,
  options: MinecraftRuntimeOptions,
): Promise<MinecraftRuntime> {
  await using resources = new AsyncDisposableStack();
  const botData = resources.use(SqlBotData.create(options.botData));
  const strongholdEyeFlights = resources.use(new StrongholdEyeFlights(bot));
  const runner = new ActionRunner({ highlighter: options.highlighter, tools: () => snapshotTools(bot), position: () => bot.entity?.position ? {
    dimension: bot.game.dimension, x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
  } : null });
  const sampleProgress = () => runner.samplePosition();
  const resetProgress = () => runner.samplePosition("server_reposition");
  resources.defer(observeCombatResourceEvents(bot, runner));
  bot.on("physicsTick", sampleProgress);
  bot.on("forcedMove", resetProgress);
  bot.on("death", resetProgress);
  bot.on("game", resetProgress);
  resources.defer(() => {
    bot.off("physicsTick", sampleProgress); bot.off("forcedMove", resetProgress);
    bot.off("death", resetProgress); bot.off("game", resetProgress);
  });
  const reflexes = resources.use(new ReflexDriver(bot, runner));
  const navigation = resources.use(createNavigationRuntime(bot));
  installMinecraftKnowledge(botData, bot.registry);
  const frontier = resources.use(attachSessionFrontier(bot, botData));
  const perception = resources.use(new CombatPerception(bot));
  const footingRecovery = resources.use(new FootingRecovery(bot, navigation.world));
  const combat = (options.createCombatController ?? createCombatController)(
    bot,
    navigation,
    perception,
    footingRecovery,
    reflexes,
  );
  const survival = resources.use(new SurvivalObserver(bot, runner, reflexes, combat));
  const incidents = resources.adopt(
    observeIncidents(bot, navigation, {
      perception,
      survival: () => survival.snapshot(),
      directory:
        options.incidents?.directory ??
        (botData.location.kind === "persistent"
          ? path.join(path.dirname(botData.location.file), "incidents")
          : path.join(os.tmpdir(), "mine-ai-incidents", randomUUID())),
      identity: {
        ...options.botData.identity,
        username: bot.username,
        provenance: options.incidents?.provenance ?? null,
      },
      retention: options.incidents?.retention,
      owner: () => {
        const { requestId, preceding } = runner.requestContext();
        return {
          requestId,
          session: runner.status(),
          footing: footingRecovery.snapshot(),
          combat: {
            targetId: combat.activeEngagement()?.targetId ?? null,
            position: combat.activePosition(),
            execution: combat.execution(),
          },
          precedingRequestId:
            requestId === null && preceding && Date.now() - preceding.completedAtMs <= INCIDENT_HISTORY_MS
              ? preceding.requestId
              : null,
        };
      },
      published: (reference) => recordIncident(botData, reference),
    }),
    (observer) => observer.close(),
  );
  resources.use(
    attachSurvivalReceipts(bot, botData, runner, reflexes, combat, survival, navigation, (receipt) =>
      incidents.recorder.record("survival_receipt", { receipt }),
    ),
  );
  resources.defer(observeReflexActivity(reflexes, combat, runner));
  resources.defer(
    observeExecution((event) => {
      if (event.owner.bot !== bot.username) return;
      const { requestId } = runner.requestContext();
      incidents.recorder.record("execution", { requestId, event });
      if (event.kind === "yielded" && event.firstYield)
        void incidents.recorder.capture("execution_slice_exhausted", requestId);
    }),
  );
  // One originating request remains attached even after that caller returns
  // while defence continues. The map is scoped to active engagements only.
  const engagementRequests = new Map<string, number | null>();
  resources.defer(
    combat.onDecision((event) => {
      incidents.recorder.record("combat_decision", {
        requestId: runner.requestContext().requestId,
        session: runner.status(),
        event,
      });
      if (event.kind !== "engagement") return;
      const id = event.execution.progress.engagementId;
      if (event.state === "started") engagementRequests.set(id, runner.requestContext().requestId);
      const requestId = engagementRequests.get(id) ?? null;
      if (event.state === "waiting" || event.state === "stall")
        void incidents.recorder.capture("combat_waiting", requestId);
      if (event.state === "ended") engagementRequests.delete(id);
    }),
  );
  let disconnected = false;
  const connectionLost = (reason: string) => {
    if (disconnected) return;
    disconnected = true;
    incidents.connectionLost(reason);
    runner.disconnect(reason);
    void combat.policy
      .reset("Connection ended; defaults restored.")
      .catch((cause) => combat.policy.constrain(String(cause)));
    options.onDisconnect?.(reason);
  };
  const ended = (reason: string) => connectionLost(`Minecraft connection ended: ${reason}`);
  bot.once("end", ended);
  resources.defer(() => {
    bot.off("end", ended);
  });
  resources.defer(observePlayerEvents(bot, botData, (reason) => runner.cancelActive(reason, { kind: "death" })));
  resources.defer(observeEquipmentEvents(bot, botData));
  resources.defer(observeBotStatus(bot, botData));
  let bodyDimension = bot.game.dimension;
  const retireWorld = () => {
    if (bodyDimension === bot.game.dimension) return;
    const from = bodyDimension;
    bodyDimension = bot.game.dimension;
    runner.dimensionChanged(from, bodyDimension);
  };
  bot.on("game", retireWorld);
  resources.defer(() => {
    bot.off("game", retireWorld);
  });
  const actions = createActions(
    {
      budgets: reflexes.budgets,
      bot,
      botData,
      frontier,
      navigation,
      strongholdEyeFlights,
      combat,
      cancelForegroundAction: runner.cancelActive,
      observeStatusActivity: () => {
        const { owner, activeAction } = runner.status();
        return { owner, activeAction };
      },
    },
    { debugExecuteJavaScript: options.debugExecuteJavaScript },
  );
  installActionQueryCatalog(botData, actionSqlQueries(actions));
  resources.use(attachBreathReflex(bot, reflexes, () => navigation.diveBackstop?.() ?? null));
  resources.use(attachIdleWaterControl(bot, navigation, runner));
  resources.use(attachFireReflex(bot, reflexes, navigation.world));
  resources.use(attachFootingReflex(reflexes, combat, footingRecovery, navigation.releaseForTakeover,
    { maintain: () => guardFooting(bot, combat.policy.combat), release: () => bot.deactivateItem() }));
  resources.use(attachDragonReflex(bot, reflexes, combat));
  resources.use(attachEndermanGazeControl(bot, () => combat.activeEngagement()));
  const hostiles = resources.use(attachHostileReflex(bot, reflexes, navigation, combat, perception));
  // The one place that holds both the navigation runtime and combat's live view
  // of who is a threat, so the one place that can join them. Every route the
  // bot takes from here is priced to prefer going around a hostile; combat's
  // own routes, which walk toward one on purpose, pass `stepField: null`.
  navigation.setStepFieldProvider(
    options.stepFieldProvider ?? createHostileStepFieldProvider(
      bot, hostiles.threats, hostiles.activeResponse, () => combat.policy.effective.navigation,
    ),
  );
  resources.use(attachHungerReflex(bot, reflexes, combat, combat.policy));

  return new AttachedMinecraftRuntime(
    bot,
    botData,
    options.botData.identity.scope.kind,
    frontier,
    runner,
    actions,
    navigation,
    resources.move(),
    incidents,
    combat.policy,
    connectionLost,
    combat,
    survival,
  );
}
