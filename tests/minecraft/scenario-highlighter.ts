import type { Bot } from "mineflayer";
import type { NodeClientSession } from "mine-labs/client";
import { BlockHighlighter, routeOrigin, routePoint } from "@aibengineering/minecraft-block-highlighter";
import type { NavigationRuntime } from "@aibengineering/mine-ai-mcp";

/** Optional viewer wiring; it observes the real navigator without replacing any movement behavior. */
export async function openScenarioHighlighter(bot: Bot, session: NodeClientSession) {
  const offset = session.scenario.spectator?.systemProperties["blockhighlighter.serverPortOffset"];
  // A world has one viewer feed. Multi-player fixtures display their first declared participant.
  if (offset === undefined || session.username !== session.scenario.players[0]?.name) return undefined;
  const port = session.port + Number(offset);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid scenario highlighter port offset.");
  // Serve the feed where the game server is, so a viewer in Tailscale remote mode can reach it too.
  const highlighter = new BlockHighlighter({ port, host: session.host }, () => bot.game.dimension);
  try {
    await highlighter.startServer();
  } catch (error) {
    // An optional viewer must not turn a playable scenario into a failed preparation.
    session.log(`highlighter unavailable: ${String(error)}`);
    await highlighter.stopServer();
    return undefined;
  }
  session.log(`highlighter feed: http://${session.host}:${port}/debug/api/highlights`);
  let unfollow: (() => void) | undefined;
  return {
    highlighter,
    follow(navigation: Pick<NavigationRuntime, "onEvent">): void {
      unfollow?.();
      unfollow = navigation.onEvent((event) => {
        if (event.kind === "route_committed") {
          highlighter.publishPath({ points: [routeOrigin(bot.entity.position), ...event.plan.steps.map((step) => routePoint(step.to))] });
        } else if (event.kind === "run_settled") {
          highlighter.clearPath();
        }
      });
    },
    async [Symbol.asyncDispose](): Promise<void> {
      unfollow?.();
      await highlighter.stopServer();
    },
  };
}
