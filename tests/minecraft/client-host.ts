/** Run one Mine Labs driver with a prepared bot and the Minecraft runtime. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Bot } from "mineflayer";
import { runNodeClient, type ClientCompletion, type NodeClientSession } from "mine-labs/client";
import {
  createMinecraftRuntime,
  type Action,
  type ActionOutput,
  type ActionResult,
  type MinecraftRuntime,
  type MinecraftRuntimeOptions,
} from "@aibengineering/mine-ai-mcp";
import { createScenarioBot, prepareScenarioBot, closeScenarioBot } from "./scenario-bot.ts";
import type { ScenarioContext, ScenarioRun, ScenarioCall } from "./scenario.ts";

const [driverFile, ...extraArgs] = process.argv.slice(2);
if (!driverFile || extraArgs.length > 0) {
  throw new Error("Usage: client-host.ts <driver module>");
}

await runNodeClient((session) => runScenario(driverFile, session));

async function runScenario(file: string, session: NodeClientSession): Promise<void> {
  const driver = await loadDriver(file);
  const bot = createScenarioBot(session);
  try {
    await prepareScenarioBot(bot, session);
    const completion = await runWithRuntime(driver, bot, session);
    session.signal.throwIfAborted();
    if (completion.status === "failed") session.log(`scenario driver failed: ${completion.detail}`);
    session.finish(completion);
  } catch (cause) {
    closeScenarioBot(bot);
    // Mine Labs already owns cancellation; it is not a second failed result.
    if (!session.signal.aborted) throw cause;
  }
}

/** The runtime is disposed before this promise resolves and completion is reported. */
async function runWithRuntime(driver: ScenarioRun, bot: Bot, session: NodeClientSession): Promise<ClientCompletion> {
  await using runtime = await createMinecraftRuntime(bot, runtimeOptions(session));
  const context: ScenarioContext = {
    scenario: session.scenario,
    call: (action, input) => callScenarioAction(runtime, session, action, input),
  };

  session.signal.throwIfAborted();
  session.prepared();
  await session.start;
  session.signal.throwIfAborted();

  // Preparation is outside the trial budget; only the driver's run is timed.
  const startedAt = Date.now();
  try {
    const completion = await driver(context);
    const detail = [completion.detail, `duration ${Date.now() - startedAt} ms`].filter(Boolean).join("; ");
    return { ...completion, detail };
  } catch (cause) {
    session.signal.throwIfAborted();
    const error = cause instanceof Error ? cause.message : String(cause);
    const detail = [error, `duration ${Date.now() - startedAt} ms`].filter(Boolean).join("; ");
    return { status: "failed", detail };
  }
}

/** Record and execute an action; the driver decides whether its result passes. */
async function callScenarioAction(
  runtime: MinecraftRuntime,
  session: NodeClientSession,
  actionName: string,
  input: Record<string, unknown>,
): Promise<ScenarioCall> {
  const action = runtime.actions.find((candidate) => candidate.name === actionName);
  if (!action) throw new Error(`The Minecraft runtime registers no '${actionName}' action.`);
  const rationale = `Scenario '${session.scenario.name ?? "unnamed"}' requested it.`;
  session.log(`${actionName} ${JSON.stringify(input)}`);
  const requestId = runtime.recordActionRequest({
    actionName,
    rationale,
    requestedAt: new Date().toISOString(),
    request: input,
  });
  const output: ActionOutput<string, ActionResult> = await runtime.run(action, input, session.signal, requestId);
  const summary = summarise(action, output);
  runtime.recordActionResponse({
    requestId,
    respondedAt: new Date().toISOString(),
    durationMs: output.durationMs,
    status: output.result.status,
    response: { ...output, summary },
  });
  session.log(summary);
  return { ...output, summary };
}

function summarise(action: Action, output: ActionOutput<string, ActionResult>): string {
  const { result } = output;
  const runtimeFailure = "kind" in result && result.kind === "runtime_failure";
  const evidence = runtimeFailure ? `runtime failure: ${result.error}` : foldMarkdown(action.formatResult(result));
  const interruptions = output.interruptions?.length ? `; interrupted by ${output.interruptions.join(" | ")}` : "";
  return `${action.name} ${result.status} in ${output.durationMs} ms; ${evidence}${interruptions}`;
}

/** An action's Markdown report as one log line: bullets become clauses, emphasis is dropped. */
function foldMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/u, "").replace(/\*\*|`/gu, ""))
    .filter((line) => line.length > 0)
    .join("; ");
}

/** Keep each trial's runtime evidence in its Mine Labs artifact directory. */
function runtimeOptions(session: NodeClientSession): MinecraftRuntimeOptions {
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  const worldId = session.scenario.name ?? "scenario";
  return {
    ...(artifacts
      ? { incidents: { directory: path.join(artifacts, session.username, "incidents") } }
      : {}),
    botData: {
      // A failed run needs the whole semantic chronology after the client
      // closes; incident files only keep bounded physical windows.
      storage: artifacts ? { kind: "persistent", root: path.join(artifacts, "bot-data") } : { kind: "temporary" },
      identity: { worldId, scope: { kind: "bot", botId: session.username } },
    },
    onDisconnect: (reason) => session.log(`runtime disconnected: ${reason}`),
  };
}

/**
 * Load test behavior separately so scenarios can choose different logic while
 * sharing this host's bot setup, runtime lifetime and action recording.
 * Ordinary scenarios all select single-action.ts and vary their YAML action,
 * input and goals; only custom logic needs another driver module. Each module
 * exports run(context), which receives scenario data and recorded action calls.
 */
async function loadDriver(file: string): Promise<ScenarioRun> {
  const absolutePath = path.resolve(process.cwd(), file);
  const module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  const { run } = module;
  if (typeof run !== "function") throw new Error(`scenario driver '${file}' must export run(context)`);
  return run as ScenarioRun;
}
