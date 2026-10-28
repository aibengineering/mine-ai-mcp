import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { ReflexDriver } from "../control/driver.js";
import { airSupplyPoints, isInWater } from "../perception/body.js";
import { decideBreathResponse, needsBreathResponse } from "../policy/environment.js";
import { geometryAnswer } from "../positioning/combat/geometry-answer.js";
import { swimmingRoof } from "../positioning/swimming-roof.js";
import { type AirRoute, ESCAPE_SEARCH, surface } from "../responses/breath.js";
import { airSupplyTicks } from "../../world/air-supply.js";

/** What the runner reports as the body's owner while the bot surfaces for air. */
export const BREATH_REFLEX = "breath_reflex" as const;
/** Check air every quarter second while another action or idle buoyancy owns movement. */
const CHECK_INTERVAL_TICKS = 5;

/** Why the body went back without full air, when navigation found no way to it. */
function noRouteToAir(routes: readonly AirRoute[]): string | null {
  const last = routes.at(-1);
  return last?.status === "stopped" ? `No route to air: ${last.reason}` : null;
}

/** The breathing response owns only its registration; runtime attaches idle buoyancy separately. */
export function attachBreathReflex(
  bot: Bot,
  driver: ReflexDriver,
  navigation: Pick<NavigationRuntime, "navigate" | "world" | "diveBackstop">,
): AsyncDisposable {
  return driver.register({
    name: BREATH_REFLEX,
    intervalTicks: CHECK_INTERVAL_TICKS,
    sense: () => {
      const air = airSupplyPoints(bot);
      if (air === null) return { kind: "unknown", missing: "own_air_metadata" };
      if (!isInWater(bot)) return null;
      const roof = swimmingRoof(bot)?.name ?? null;
      const floor = navigation.diveBackstop?.() ?? null;
      if (floor === null ? !needsBreathResponse(air, roof) : (airSupplyTicks(bot) ?? 0) > floor) return null;
      return { kind: "observed", danger: { air, ownedDive: floor !== null }, evidence: { air, roof } };
    },
    decide: ({ air, ownedDive }) => {
      const decision = decideBreathResponse(air);
      return decision.kind === "respond" ? { ...decision, response: { ...decision.response, ownedDive } } : decision;
    },
    facts: () => {
      const origin = bot.entity.position.floored();
      // A failed escape stays answered until a block changes within the
      // route search's reach, or the carried tools change what it may dig.
      return geometryAnswer(navigation.world, origin, ESCAPE_SEARCH.maximumRadius, {
        capability: "breath",
        response: "surface",
        scope: `cell:${origin}`,
        facts: () => ({ tools: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) }),
        permissions: () => null,
      });
    },
    act: async ({ airBefore, maximumTicks, ownedDive }, signal) => {
      const healthBefore = bot.health;
      return {
        ...(await surface(bot, navigation, signal, driver.budgets, maximumTicks)),
        airBefore,
        ownedDive,
        healthBefore,
        healthAfter: bot.health,
      };
    },
    continuation: (outcome) =>
      outcome.ownedDive ? { kind: "return", reason: "Navigation dive budget failed; the breath backstop rescued the bot." } : outcome.kind === "air_full"
        ? { kind: "resume" }
        : {
            kind: "return",
            reason: outcome.kind === "air_unknown"
              ? "Own air metadata is unavailable."
              : noRouteToAir(outcome.routes) ?? "Full air was not observed.",
          },
    failure: (outcome) =>
      outcome.kind === "stuck"
        ? {
            kind: "stuck",
            why: noRouteToAir(outcome.routes) ?? "The surface attempt ended before full air was observed.",
          }
        : null,
    describe: (outcome) => outcome,
  });
}
