import type { Bot } from "mineflayer";
import type { ReflexDriver } from "../control/driver.js";
import { airSupplyPoints, isInWater } from "../perception/body.js";
import { decideBreathResponse, needsBreathResponse } from "../policy/environment.js";
import { swimmingRoof } from "../positioning/swim-escape.js";
import { surface } from "../responses/breath.js";
import { airSupplyTicks } from "../../world/air-supply.js";

/** What the runner reports as the body's owner while the bot surfaces for air. */
export const BREATH_REFLEX = "breath_reflex" as const;
/** Check air every quarter second while another action or idle buoyancy owns movement. */
const CHECK_INTERVAL_TICKS = 5;

/** The breathing response owns only its registration; runtime attaches idle buoyancy separately. */
export function attachBreathReflex(bot: Bot, driver: ReflexDriver, diveBackstop: () => number | null = () => null): AsyncDisposable {
  return driver.register({
    name: BREATH_REFLEX,
    intervalTicks: CHECK_INTERVAL_TICKS,
    sense: () => {
      const air = airSupplyPoints(bot);
      if (air === null) return { kind: "unknown", missing: "own_air_metadata" };
      if (!isInWater(bot)) return null;
      const roof = swimmingRoof(bot)?.name ?? null;
      const floor = diveBackstop();
      if (floor === null ? !needsBreathResponse(air, roof) : (airSupplyTicks(bot) ?? 0) > floor) return null;
      return { kind: "observed", danger: { air, ownedDive: floor !== null }, evidence: { air, roof } };
    },
    decide: ({ air, ownedDive }) => {
      const decision = decideBreathResponse(air);
      return decision.kind === "respond" ? { ...decision, response: { ...decision.response, ownedDive } } : decision;
    },
    facts: () => {
      const origin = bot.entity.position.floored();
      return {
        capability: "breath",
        response: "surface",
        scope: `cell:${origin}`,
        facts: () => {
          const cells: (number | null)[] = [];
          // The physical method checks a two-block lateral corridor and the next swim stroke.
          for (let x = -2; x <= 2; x++)
            for (let z = -2; z <= 2; z++)
              for (let y = -1; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
          return { cells, tools: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) };
        },
        permissions: () => null,
      };
    },
    act: async ({ airBefore, maximumTicks, ownedDive }, signal) => {
      const healthBefore = bot.health;
      return {
        ...(await surface(bot, signal, driver.budgets, maximumTicks)),
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
            reason: outcome.kind === "air_unknown" ? "Own air metadata is unavailable." : "Full air was not observed.",
          },
    failure: (outcome) =>
      outcome.kind === "stuck"
        ? { kind: "stuck", why: "The surface attempt ended before full air was observed." }
        : null,
    describe: (outcome) => outcome,
  });
}
