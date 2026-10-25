/**
 * The evidence tour's Mine Labs client. It prepares the bot exactly as the
 * scenario suite does, then hands it to the capture, which wraps its own
 * runtime in the MCP server: unlike the suite's drivers, this tour exercises
 * MCP transport and the submit/wait protocol.
 */
import { runNodeClient } from "mine-labs/client";
import { closeScenarioBot, createScenarioBot, prepareScenarioBot } from "../../tests/minecraft/scenario-bot.ts";
import { captureActionEvidence } from "./capture.ts";

await runNodeClient(async (session) => {
  const bot = createScenarioBot(session);
  try {
    await prepareScenarioBot(bot, session);
    session.prepared();
    await session.start;
    session.signal.throwIfAborted();
    const completion = await captureActionEvidence({
      bot,
      scenario: session.scenario,
      signal: session.signal,
      log: session.log,
    });
    session.signal.throwIfAborted();
    session.finish(completion);
  } catch (cause) {
    closeScenarioBot(bot);
    // Mine Labs already owns cancellation; it is not a second failed result.
    if (!session.signal.aborted) throw cause;
  }
});
