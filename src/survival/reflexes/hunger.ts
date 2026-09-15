import type { Bot } from "mineflayer";
import { eatFood } from "../../actions/eat-food/eat-food.js";
import type { CombatController } from "../control/combat/contract.js";
import type { ReflexDriver } from "../control/driver.js";
import { selectPolicyFood } from "../perception/food.js";
import { BodyAbort } from "../../session/abort.js";
import { isRawFood } from "../../world/food.js";
import { rawFoodPermitted } from "../policy/food.js";
import type { SurvivalPolicyState } from "../state/survival-policy.js";
import { decideHungerResponse, needsFood } from "../policy/environment.js";

/** What the runner reports as the body's owner while the bot eats. */
export const HUNGER_REFLEX = "hunger_reflex" as const;
const CHECK_INTERVAL_TICKS = 20;

/** Eating yields to active combat, including combat owned by a model request. */
export function attachHungerReflex(
  bot: Bot,
  driver: ReflexDriver,
  combat: Pick<CombatController, "activeEngagement">,
  policy: SurvivalPolicyState,
): AsyncDisposable {
  let activeFood: string | null = null;
  const registration = driver.register({
    name: HUNGER_REFLEX,
    intervalTicks: CHECK_INTERVAL_TICKS,
    sense: () => {
      if (policy.settling || !needsFood(bot.health, bot.food)) return null;
      const owner = driver.runner.status().owner;
      const bodyBusy = owner === "takeover" || owner === "yielding";
      const combatActive = combat.activeEngagement() !== null;
      const selection = bodyBusy || combatActive ? null : selectPolicyFood(bot, policy.food);
      const facts = {
        food: bot.food,
        health: bot.health,
        selectedFood: selection?.food?.name ?? null,
        withheldRaw: selection?.withheld?.name ?? null,
        rawFoodRule: selection?.withheld ? selection.verdict.reason : null,
        bodyBusy,
        combatActive,
      };
      return { kind: "observed", danger: facts, evidence: facts };
    },
    decide: decideHungerResponse,
    facts: (food) => ({
      capability: "hunger",
      response: "eat",
      scope: `food:${food}`,
      facts: () => ({
        hunger: bot.food,
        food: bot.inventory
          .items()
          .filter((item) => item.name === food)
          .map((item) => item.count),
      }),
      permissions: () => isRawFood(food) ? { ...policy.food.raw } : null,
    }),
    act: async (food, signal) => {
      // A policy edit can land after sensing but before body admission.
      if (isRawFood(food) && !rawFoodPermitted(policy.food.raw, { health: bot.health, hunger: bot.food }).permitted)
        throw new BodyAbort({ kind: "policy_changed", revision: policy.snapshot().revision }, "Food policy revoked this meal.");
      const hungerBefore = bot.food;
      const saturationBefore = bot.foodSaturation;
      activeFood = food;
      const result = await eatFood(bot, { foodName: food }, { signal }).finally(() => {
        activeFood = null;
      });
      return {
        kind: result.eating.consumed ? ("ate" as const) : ("eating_failed" as const),
        food,
        hungerBefore,
        hungerAfter: bot.food,
        saturationBefore,
        saturationAfter: bot.foodSaturation,
        error: result.status === "succeeded" ? null : result.error,
      };
    },
    continuation: () => ({ kind: "resume" }),
    failure: (outcome) =>
      outcome.kind === "eating_failed"
        ? { kind: outcome.kind, why: outcome.error ?? "Food consumption was not observed." }
        : null,
    describe: (outcome) => outcome,
  });
  const unsubscribe = policy.onChange(async (snapshot) => {
    if (activeFood === null || !isRawFood(activeFood)) return;
    if (rawFoodPermitted(policy.food.raw, { health: bot.health, hunger: bot.food }).permitted) return;
    await driver.cancel(HUNGER_REFLEX,
      new BodyAbort({ kind: "policy_changed", revision: snapshot.revision }, "Food policy revoked this meal."));
  });
  return {
    [Symbol.asyncDispose]: async () => {
      unsubscribe();
      await registration[Symbol.asyncDispose]();
    },
  };
}
