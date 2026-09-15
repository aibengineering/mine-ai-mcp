import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mineflayer, { type Bot } from "mineflayer";
import { runNodeClient, type NodeClientSession } from "mine-labs/client";
import {
  BOT_PHYSICS_OPTIONS,
  assertBotPluginsLoaded,
  createNavigationRuntime,
  loadBotPlugins,
} from "@aibengineering/mine-ai-mcp";

import { installScenarioPathfinder } from "./pathfinder-implementation.ts";
import { observeScenarioPlayerPreparation } from "./player-preparation.ts";
import type { MineAiScenario, MineAiScenarioContext, MineAiScenarioPreparation } from "./scenario-client.ts";

const scenarioFile = process.argv[2];
if (!scenarioFile) throw new Error("Mine AI scenario client requires a test module path");

await runNodeClient((session) => runMineAiScenario(scenarioFile, session));

/** Own the Mineflayer connection and run one test after Mine Labs prepares it. */
async function runMineAiScenario(file: string, session: NodeClientSession): Promise<void> {
  const { run, prepare } = await loadScenarioTest(file);
  const bot = createScenarioBot(session);
  session.signal.addEventListener("abort", () => closeBot(bot), { once: true });
  forwardChat(bot, session);
  holdStillWhileChunksLoad(bot);

  await waitForSpawn(bot, session.username);
  assertBotPluginsLoaded(bot);
  const preparation = observeScenarioPlayerPreparation(bot, session.scenario, session.signal);
  try {
    session.ready();
    await session.arranged;
    if (session.signal.aborted) return;
    await preparation.wait();
  } finally {
    preparation.close();
  }
  if (session.signal.aborted) return;

  // Observe the same package-local Pathfinder every production action uses.
  await using navigation = createNavigationRuntime(bot);
  const pathfinder = installScenarioPathfinder(bot, {
    bot,
    navigation,
    scenario: session.scenario,
    signal: session.signal,
    log: session.log,
  } as MineAiScenarioContext);

  const context: MineAiScenarioContext = {
    bot,
    navigation,
    scenario: session.scenario,
    signal: session.signal,
    log: session.log,
    pathfinder,
  };

  let startedAt: number | undefined;
  try {
    await prepare?.(context);
    if (session.signal.aborted) return;
    session.prepared();
    await session.start;
    if (session.signal.aborted) return;
    startedAt = Date.now();
    const completion = await run(context);
    if (!session.signal.aborted) {
      const elapsedMs = Date.now() - startedAt;
      // Drivers that already appended the summary themselves keep theirs; the
      // rest get it here. Either way it appears exactly once, and it carries
      // the memory figures, so the host no longer runs a second probe of the
      // same process to say the same thing.
      const alreadySummarised = completion.detail?.includes("search slices ");
      const existingDetail = completion.detail ? `${completion.detail}; ` : "";
      const enrichedDetail = alreadySummarised
        ? `${completion.detail}; duration ${elapsedMs} ms`
        : `${existingDetail}duration ${elapsedMs} ms; ${pathfinder.summary()}`;
      session.finish({ ...completion, detail: enrichedDetail });
    }
  } catch (cause) {
    if (session.signal.aborted) return;
    if (startedAt === undefined) throw cause;
    const elapsedMs = Date.now() - startedAt;
    const complaint = cause instanceof Error ? cause.message : String(cause);
    const detail = `${complaint}; duration ${elapsedMs} ms; ${pathfinder.summary()}`;
    session.log(`scenario client failed: ${detail}`);
    session.finish({ status: "failed", detail });
  } finally {
    pathfinder.close();
  }
}

function createScenarioBot(session: NodeClientSession): Bot {
  const bot = mineflayer.createBot({
    host: session.host,
    port: session.port,
    username: session.username,
    version: session.version,
    auth: "offline",
    ...BOT_PHYSICS_OPTIONS,
  });
  loadBotPlugins(bot);
  return bot;
}

async function loadScenarioTest(file: string): Promise<{ run: MineAiScenario; prepare?: MineAiScenarioPreparation }> {
  const absolutePath = resolve(process.cwd(), file);
  const module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  const defaultExport = module.default;
  const nestedRun =
    defaultExport !== null && typeof defaultExport === "object"
      ? (defaultExport as Record<string, unknown>).run
      : undefined;
  const run =
    typeof module.run === "function" ? module.run : typeof defaultExport === "function" ? defaultExport : nestedRun;
  if (typeof run !== "function") {
    throw new Error(`scenario test '${file}' must export run(context)`);
  }
  const prepare = module.prepare ?? (defaultExport !== null && typeof defaultExport === "object"
    ? (defaultExport as Record<string, unknown>).prepare : undefined);
  if (prepare !== undefined && typeof prepare !== "function") {
    throw new Error(`scenario test '${file}' prepare export must be a function`);
  }
  return { run: run as MineAiScenario, prepare: prepare as MineAiScenarioPreparation | undefined };
}

function waitForSpawn(bot: Bot, username: string): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const timeout = setTimeout(
      () => rejectSpawn(new Error(`client '${username}' did not spawn within 60 seconds`)),
      60_000,
    );
    bot.once("spawn", () => {
      clearTimeout(timeout);
      resolveSpawn();
    });
    bot.once("error", (error) => {
      clearTimeout(timeout);
      rejectSpawn(error);
    });
  });
}

/**
 * A teleport into another dimension respawns the client into chunks it has
 * not received yet. Mineflayer keeps simulating physics against that empty
 * world and falls through the terrain the server is still sending, so the
 * player ends up inside a wall once it arrives. Stand still after every
 * spawn until the column under the new position has loaded — only that one:
 * the rest of a fresh Nether view takes the server longer to generate than
 * the arrangement handshake allows.
 */
function holdStillWhileChunksLoad(bot: Bot): void {
  bot.on("spawn", () => {
    bot.physicsEnabled = false;
    // A column that never arrives is reported by the arrangement timeout;
    // physics resumes either way so the player is not left frozen.
    void standingColumnLoaded(bot)
      .catch(() => undefined)
      .finally(() => {
        bot.physicsEnabled = true;
      });
  });
}

async function standingColumnLoaded(bot: Bot): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (bot.blockAt(bot.entity.position) === null) {
    if (Date.now() > deadline) throw new Error(`column under ${bot.entity.position} did not load within 30s`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function forwardChat(bot: Bot, session: NodeClientSession): void {
  bot.on("chat", (_username, message) => session.chat(message));
  bot.on("messagestr", (message) => session.chat(message));
}

function closeBot(bot: Bot): void {
  try {
    bot.quit();
  } catch {
    // The bot may already have disconnected itself.
  }
  try {
    bot._client.socket.destroy();
  } catch {
    // The transport may already be closed.
  }
}
