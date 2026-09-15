import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../src/navigation/index.ts";
import type { ClientCompletion, ScenarioDefinition } from "mine-labs/client";
import type { PathfinderTrace } from "./pathfinder-implementation.ts";

/** Everything a Mine AI scenario test receives after its player is prepared. */
export interface MineAiScenarioContext {
  bot: Bot;
  /** The one navigation runtime for this scenario's bot, built by the host. */
  navigation: NavigationRuntime;
  scenario: ScenarioDefinition;
  signal: AbortSignal;
  log(message: string): void;
  /**
   * Telemetry from the package-local Pathfinder installed by the bot host.
   * A driver never installs or translates its own navigation implementation.
   */
  pathfinder: PathfinderTrace;
}

export type MineAiScenario = (context: MineAiScenarioContext) => Promise<ClientCompletion>;

/**
 * Driver-side arrangement the scenario file cannot express — the state of a
 * dragon fight, say. The dimension, starting position, health, inventory and
 * declared entities are the scenario's own, and are in place before this
 * runs. Completes before the observer is placed and `start` is sent.
 */
export type MineAiScenarioPreparation = (context: MineAiScenarioContext) => Promise<void>;
