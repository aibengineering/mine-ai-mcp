/** Connect one Mineflayer bot and host the Mine AI MCP server. */
import { createMinecraftMcpHttpApplication } from "./http.js";
import { attachHighlighter } from "@aibengineering/minecraft-block-highlighter";
import mineflayer, { type Bot } from "mineflayer";
import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { BOT_PHYSICS_OPTIONS, assertBotPluginsLoaded, loadBotPlugins } from "../bot-capabilities.js";
import {
  deriveMinecraftBotDataIdentity,
  type BotDataScope,
  type MinecraftBotDataIdentity,
  type SqlBotDataOptions,
} from "../bot-data/index.js";
import { snapshotInventory } from "../bot-data/bot-status.js";
import type { SourceIdentity } from "../diagnostics/incident-recorder.js";
import { createMinecraftRuntime, type MinecraftRuntime } from "../runtime/minecraft-runtime.js";
import type { HostOptions } from "./config.js";
import { registerIncidentCaptureRoute } from "./incident-route.js";
import { createMinecraftMcpServer } from "./mcp.js";

const DEBUG_CONNECTION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

interface ConnectedBot extends Disposable {
  readonly bot: Bot;
  readonly identity: MinecraftBotDataIdentity;
}

interface SpawnedActionHost {
  readonly bot: Bot;
  readonly loginPacket: unknown;
}

type LoginPacketCapture = { readonly kind: "waiting" } | { readonly kind: "received"; readonly packet: unknown };

type ConnectionSettlement =
  | { readonly kind: "ready"; readonly connection: SpawnedActionHost }
  | { readonly kind: "failed"; readonly error: Error };

async function connectBot(configuration: HostOptions): Promise<ConnectedBot> {
  using resources = new DisposableStack();
  const bot = mineflayer.createBot({
    host: configuration.minecraftHost,
    port: configuration.minecraftPort,
    username: configuration.username,
    auth: configuration.auth,
    version: configuration.version,
    ...BOT_PHYSICS_OPTIONS,
  });
  // Survival perception, navigation, and diagnostics each keep a permanent
  // respawn and physicsTick listener; the steady-state count sits just past
  // Node's default cap of ten, so raise it while keeping a finite ceiling
  // so a genuine listener leak still warns.
  bot.setMaxListeners(40);
  resources.defer(() => bot.quit("Minecraft MCP server stopped."));
  loadBotPlugins(bot);

  using listeners = new DisposableStack();
  const connection = await new Promise<SpawnedActionHost>((resolve, reject) => {
    let capture: LoginPacketCapture = { kind: "waiting" };
    const loggedIn = (packet: unknown) => {
      capture = { kind: "received", packet };
    };
    const finish = (settlement: ConnectionSettlement) => {
      listeners.dispose();
      if (settlement.kind === "failed") {
        reject(settlement.error);
        return;
      }
      resolve(settlement.connection);
    };
    const spawned = () => {
      try {
        assertBotPluginsLoaded(bot);
        if (capture.kind === "waiting") {
          throw new Error("Minecraft spawned before supplying its login packet for bot data.");
        }
        finish({ kind: "ready", connection: { bot, loginPacket: capture.packet } });
      } catch (cause) {
        finish({ kind: "failed", error: cause instanceof Error ? cause : new Error(String(cause)) });
      }
    };
    const failed = (error: Error) => finish({ kind: "failed", error });
    const kicked = (reason: unknown) =>
      finish({
        kind: "failed",
        error: new Error(`Minecraft kicked ${configuration.username}: ${String(reason)}`),
      });
    const timer = setTimeout(
      () =>
        finish({
          kind: "failed",
          error: new Error(`Minecraft connection timed out after ${configuration.connectTimeoutMs} ms.`),
        }),
      configuration.connectTimeoutMs,
    );
    listeners.defer(() => clearTimeout(timer));
    bot._client.once("login", loggedIn);
    listeners.defer(() => {
      bot._client.off("login", loggedIn);
    });
    bot.once("spawn", spawned);
    listeners.defer(() => {
      bot.off("spawn", spawned);
    });
    bot.once("error", failed);
    listeners.defer(() => {
      bot.off("error", failed);
    });
    bot.once("kicked", kicked);
    listeners.defer(() => {
      bot.off("kicked", kicked);
    });
  });

  const identity = deriveMinecraftBotDataIdentity({
    host: configuration.minecraftHost,
    port: configuration.minecraftPort,
    playerUuid: connection.bot.player?.uuid ?? connection.bot._client.uuid,
    loginPacket: connection.loginPacket,
  });
  const lifetime = resources.move();
  return { bot: connection.bot, identity, [Symbol.dispose]: () => lifetime.dispose() };
}

export interface RuntimeHost extends AsyncDisposable {
  readonly server: HttpServer;
  close(): Promise<void>;
}

export async function startRuntimeHost(source: SourceIdentity, configuration: HostOptions): Promise<RuntimeHost> {
  await using resources = new AsyncDisposableStack();
  const { bot, identity } = resources.use(await connectBot(configuration));
  let connected = true;
  let running = false;
  let connectionFailure: Error | null = null;
  let runtime: MinecraftRuntime | null = null;
  let stopPromise: Promise<void> | null = null;

  const connectionEnded = (failure: Error) => {
    connected = false;
    if (!running) {
      connectionFailure ??= failure;
    } else if (!stopPromise) {
      // Leave HTTP available to deliver pending failures and report the lost
      // connection. Closing SSE first strands the caller in SDK reconnection.
      // A new Minecraft connection requires an explicit service restart.
      process.stderr.write(`[mine-ai-mcp] ${failure.message}\n`);
    }
  };
  const endedDuringStartup = (reason: string) => connectionEnded(new Error(`Minecraft connection ended: ${reason}`));
  bot.once("end", endedDuringStartup);
  resources.defer(() => {
    bot.off("end", endedDuringStartup);
  });
  const failedConnection = (failure: Error) =>
    runtime ? runtime.disconnect(failure.message) : connectionEnded(failure);
  bot.on("error", failedConnection);
  const kicked = (reason: unknown) =>
    failedConnection(new Error(`Minecraft kicked ${configuration.username}: ${String(reason)}`));
  bot.on("kicked", kicked);
  resources.defer(() => {
    bot.off("error", failedConnection);
    bot.off("kicked", kicked);
  });

  const assertConnected = () => {
    if (connectionFailure) throw connectionFailure;
  };

  // Routes follow the bot from here on, and the highlighter owns the feed and
  // its audience. Every presentation decision stays at the highlight call.
  const { highlighter } = resources.adopt(attachHighlighter(bot, { serveStandalone: false }), (attachment) =>
    attachment.stop(),
  );
  const scope: BotDataScope =
    configuration.botData.scope === "shared" ? { kind: "shared" } : { kind: "bot", botId: identity.botId };
  const botDataOptions = {
    storage: configuration.botData.storage,
    identity: { worldId: identity.worldId, scope },
  } satisfies SqlBotDataOptions;
  const activeRuntime = resources.use(
    await createMinecraftRuntime(bot, {
      highlighter,
      botData: botDataOptions,
      debugExecuteJavaScript: configuration.debugExecuteJavaScript,
      onDisconnect: (reason) => connectionEnded(new Error(reason)),
      incidents: {
        retention: configuration.incidentRetention,
        provenance: {
          source,
          instanceId: configuration.instanceId,
          minecraft: { host: configuration.minecraftHost, port: configuration.minecraftPort },
        },
      },
    }),
  );
  runtime = activeRuntime;
  bot.off("end", endedDuringStartup);
  assertConnected();

  // Register the listener before the application: disposal must close MCP
  // sessions (including SSE streams) before waiting for HTTP to drain.
  const httpServer = resources.adopt(createServer(), async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const application = resources.adopt(
    createMinecraftMcpHttpApplication({
      host: configuration.listenHost,
      createServer: () => createMinecraftMcpServer(activeRuntime, bot.username).server,
      health: () => {
        const position = bot.entity?.position;
        const feet = position?.floored();
        return {
          connected,
          username: bot.username,
          // Reported so a caller can prove an action took no damage, which is
          // the invariant hardest to check from an action's own result.
          health: bot.health ?? null,
          food: bot.food ?? null,
          gamemode: bot.game?.gameMode ?? bot.players?.[bot.username]?.gamemode ?? null,
          position: position ? { x: position.x, y: position.y, z: position.z } : null,
          standingOn: feet ? bot.blockAt(feet.offset(0, -1, 0))?.name || null : null,
          // The client is sent only another player's six equipment slots, so
          // an observer can draw a real inventory only from the host that owns
          // the connection.
          inventory: snapshotInventory(bot),
          ...activeRuntime.status(),
          recentCalls: activeRuntime.recentCalls(),
          debug: {
            executeJavaScript: configuration.debugExecuteJavaScript,
            suspendConnectionTimeouts: configuration.debugExecuteJavaScript,
          },
          overlay: {
            watching: highlighter.listening(),
          },
        };
      },
      clientIdleTimeoutMs: configuration.debugExecuteJavaScript ? DEBUG_CONNECTION_TIMEOUT_MS : undefined,
      log: (message) => process.stdout.write(`[mine-ai-mcp] ${message}\n`),
    }),
    (application) => application.close(),
  );
  httpServer.on("request", application.app);
  registerIncidentCaptureRoute(application.app, activeRuntime);
  // The highlighter answers its own feed; anything it does not own falls
  // through to the MCP routes untouched.
  application.app.use((request, response, next) => {
    const answer = highlighter.handle(request.method, request.originalUrl);
    if (!answer) return next();
    response.status(answer.status).json(answer.body);
  });

  await once(httpServer.listen(configuration.listenPort, configuration.listenHost), "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Minecraft MCP requires a TCP listener.");
  if (configuration.debugExecuteJavaScript) {
    httpServer.requestTimeout = 0;
    httpServer.timeout = 0;
  }
  assertConnected();
  running = true;

  const runtimeStatus = activeRuntime.status();
  process.stdout.write(
    `[mine-ai-mcp] ${configuration.instanceId} runtime ready on port ${address.port} as ${bot.username}; ${runtimeStatus.botData.persistence} ${runtimeStatus.botData.scope} frontier has ${runtimeStatus.frontier.observedChunks} chunks.\n`,
  );
  const lifetime = resources.move();
  const close = () => (stopPromise ??= lifetime.disposeAsync());
  return { server: httpServer, close, [Symbol.asyncDispose]: close };
}
