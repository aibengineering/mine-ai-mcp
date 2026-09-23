import { once, type EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import mineflayer, { type Bot } from "mineflayer";
import type { NodeClientSession } from "mine-labs/client";
import { BOT_PHYSICS_OPTIONS, assertBotPluginsLoaded, loadBotPlugins } from "@aibengineering/mine-ai-mcp";
import { observeScenarioPlayerPreparation } from "../../scenarios/src/player-preparation.ts";

type PreparationSession = Pick<NodeClientSession, "scenario" | "signal" | "ready" | "arranged">;

/** Physics stays paused until the arranged player and its starting terrain arrive. */
export async function prepareScenarioBot(bot: Bot, session: PreparationSession): Promise<void> {
  bot.physicsEnabled = false;
  try {
    loadBotPlugins(bot);
    await waitForSpawnAndVitals(bot, session.signal);
    assertBotPluginsLoaded(bot);
    await waitForArrangement(bot, session);
    await waitForStandingColumn(bot, session.signal);
  } finally {
    // Setup owns this pause. No physics or spawn hooks survive into execution.
    bot.physicsEnabled = true;
  }

  // Start grounded by default so actions plan from a settled position.
  // Add an exception only when a real fixture needs to start off the ground.
  await waitForGround(bot, session.signal);
}

export function createScenarioBot(session: NodeClientSession): Bot {
  const bot = mineflayer.createBot({
    host: session.host,
    port: session.port,
    username: session.username,
    version: session.version,
    auth: "offline",
    ...BOT_PHYSICS_OPTIONS,
    physicsEnabled: false,
  });
  // Match the MCP host's allowance for runtime observers.
  bot.setMaxListeners(40);
  bot.on("error", (error) => session.log(`bot error: ${error.message}`));
  bot.on("chat", (_username, message) => session.chat(message));
  bot.on("messagestr", (message) => session.chat(message));
  // Stay connected for Mine Labs' final observations; its stop signal closes us.
  session.signal.addEventListener("abort", () => closeScenarioBot(bot), { once: true });
  return bot;
}

async function waitForSpawnAndVitals(bot: Bot, signal: AbortSignal): Promise<void> {
  // Mineflayer is a Node emitter; its typed-emitter declarations differ from Node's.
  const events = bot as unknown as EventEmitter;
  const timeout = AbortSignal.timeout(60_000);
  const startup = AbortSignal.any([signal, timeout]);
  try {
    // Listen together: Mineflayer emits spawn and health from the same packet.
    // Receiving health establishes readiness even when food is zero.
    await Promise.all([
      once(events, "spawn", { signal: startup }),
      once(events, "health", { signal: startup }),
    ]);
  } catch (cause) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error(`Bot '${bot.username}' did not spawn and receive vitals within 60 seconds.`);
    throw cause;
  }
}

async function waitForArrangement(bot: Bot, session: PreparationSession): Promise<void> {
  const preparation = observeScenarioPlayerPreparation(bot, session.scenario, session.signal);
  try {
    session.ready();
    await session.arranged;
    session.signal.throwIfAborted();
    await preparation.wait();
  } finally {
    preparation.close();
  }
}

async function waitForStandingColumn(bot: Bot, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (bot.blockAt(bot.entity.position) === null) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error(`The starting column at ${bot.entity.position} did not load within 30 seconds.`);
    await delay(50, undefined, { signal });
  }
  signal.throwIfAborted();
}

async function waitForGround(bot: Bot, signal: AbortSignal): Promise<void> {
  const events = bot as unknown as EventEmitter;
  const settleTimeoutTicks = 200;
  const requiredStillTicks = 10;
  let lastY = bot.entity.position.y;
  let stillTicks = 0;
  for (let tick = 0; tick < settleTimeoutTicks; tick++) {
    await once(events, "physicsTick", { signal });
    const landed = bot.entity.onGround && Math.abs(bot.entity.position.y - lastY) < 1e-3;
    stillTicks = landed ? stillTicks + 1 : 0;
    lastY = bot.entity.position.y;
    if (stillTicks >= requiredStillTicks) return;
  }
  throw new Error("The bot did not settle on the ground within 200 physics ticks.");
}

export function closeScenarioBot(bot: Bot): void {
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
