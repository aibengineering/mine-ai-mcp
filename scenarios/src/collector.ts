/** Run one `collect_block` request against a real Mine Labs fixture. */
import {
  attachHighlighter,
  createCollectBlockAction,
  ActionRunner,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "./scenario-client.ts";

/** How long the bot is given to land before the request goes out anyway. */
const SETTLE_TIMEOUT_TICKS = 200;
/** Ticks of stillness that count as landed. */
const STILL_TICKS = 5;

/**
 * Wait until the bot is standing still on the ground.
 *
 * A pinned spawn is a column, not a height: the server puts the player at the
 * named coordinates and lets it fall to whatever it generated there, and
 * `waitForChunksToLoad` returns while it is still on the way down. A collect
 * issued then plans from a cell the bot is about to leave.
 */
async function standStill(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  let lastY = bot.entity.position.y;
  let still = 0;
  for (let waited = 0; waited < SETTLE_TIMEOUT_TICKS && still < STILL_TICKS; waited += 1) {
    context.signal.throwIfAborted();
    await bot.waitForTicks(1);
    still = bot.entity.onGround && Math.abs(bot.entity.position.y - lastY) < 1e-3 ? still + 1 : 0;
    lastY = bot.entity.position.y;
  }
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await standStill(context);
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });

  // `expect` and `because` describe the fixture; everything else is the action request.
  const { expect: rawExpectation, because: rawReason, ...request } = context.scenario.params;
  const expectation = rawExpectation === "refused" ? "refused" : "collected";
  const expectedReason = typeof rawReason === "string" ? rawReason : undefined;
  context.log(`collect_block ${JSON.stringify(request)} (expect ${expectation})`);
  const { result, durationMs } = await runner.run(
    createCollectBlockAction(bot, context.navigation),
    request,
    context.signal,
  );
  const error = "error" in result ? result.error : "";
  context.log(`${result.status} (${durationMs} ms)${error ? ` — ${error}` : ""}`);

  if (expectation === "refused") {
    const declined = result.status !== "succeeded";
    const matched = !expectedReason || error.includes(expectedReason);
    return declined && matched
      ? { status: "succeeded", detail: `declined as expected: ${error}` }
      : {
          status: "failed",
          detail: declined
            ? `declined, but not for ${expectedReason}: ${error}`
            : `collected a block it should have refused (${durationMs} ms)`,
        };
  }

  return {
    status: result.status === "succeeded" ? "succeeded" : "failed",
    detail: error || `action completed in ${durationMs} ms`,
  };
}
