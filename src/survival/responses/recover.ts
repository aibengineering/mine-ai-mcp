import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import type { Bot } from "mineflayer";
import { eatFood } from "../../actions/eat-food/eat-food.js";
import { REGENERATION_HUNGER } from "../../world/food.js";
import { carriedCount } from "../../world/inventory-count.js";
import { recoveryScope } from "../control/combat/scopes/recovery.js";
import { isInFire, isInLava } from "../perception/body.js";
import { selectPolicyFood } from "../perception/food.js";
import { hasRegeneration } from "../perception/combat/recovery.js";
import type { SurvivalPolicy } from "../policy/contract.js";
import { type SurvivalResources } from "../state/resources.js";

export type CoveredRecovery =
  | { readonly kind: "recovered"; readonly ate: string | null }
  | { readonly kind: "exposed"; readonly ate: string | null }
  /** Health is still short, and the hold has said why it stopped waiting. */
  | {
      readonly kind: "held";
      readonly ate: string | null;
      readonly stop: "exhausted" | "unavailable" | "eating_failed" | "answered" | "prohibited" | "death";
      readonly reason: string;
    };

/**
 * Eat and recover only while the owning position remains usable. Construction
 * and weapons belong to callers.
 *
 * A hold ends the moment it can no longer change the health bar. Below
 * eighteen hunger vanilla regenerates nothing, so a bot with nothing to eat is
 * waiting for nothing; on 2026-09-09 seven such holds cost a bot at two health
 * ninety seconds apiece, ten minutes in which the model heard nothing and
 * could do nothing. Saying so at once hands the body back sealed in, which is
 * the only thing the hold had left to offer.
 */
export async function recoverUnderCover(
  bot: Bot,
  options: {
    readonly signal: AbortSignal;
    readonly recoverTo: number;
    readonly maximumMs: number;
    readonly isProtected: () => boolean;
    /** A shelter can contain knockback without making it safe to open yet. */
    readonly holdWhile?: () => boolean;
    readonly defendIntruder: () => Promise<void>;
    /** Intruder defence may have raised a shield since this hold began. */
    readonly releaseItemUse: () => void;
    readonly wait: (ticks: number) => Promise<void>;
    readonly survival: SurvivalResources;
    readonly policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>;
  },
): Promise<CoveredRecovery> {
  let ate: string | null = null;
  const usable = () => options.isProtected() && !isInFire(bot) && !isInLava(bot) && incomingShieldProjectiles(bot).length === 0;
  options.signal.throwIfAborted();
  if (bot.health > 0 && !usable()) return { kind: "exposed", ate };
  const survival = options.survival;
  const policy = options.policy;
  const scope = recoveryScope(bot, policy, options.recoverTo);
  const answered = survival.answered.find(scope.capability, scope.scope);
  if (answered) return { kind: "held", stop: "answered", ate, reason: answered.failure.why };
  if (policy().combat.recover === "never" && !options.holdWhile)
    return { kind: "held", stop: "prohibited", ate, reason: "Recovery is prohibited." };
  using budget = survival.budgets.attempt({
    name: "covered_recovery",
    scope: scope.scope,
    unit: "milliseconds",
    limit: options.maximumMs,
    measure: Date.now,
    exhaustion: "Retain observed enclosure and return exhausted recovery with current health and hunger.",
  });
  const held = (stop: "exhausted" | "unavailable" | "eating_failed", reason: string): CoveredRecovery => {
    options.signal.throwIfAborted();
    if (bot.health <= 0) return { kind: "held", stop: "death", ate, reason: "The bot died during recovery." };
    survival.answered.remember(scope, { kind: stop, why: reason });
    return { kind: "held", stop, ate, reason };
  };
  while ((bot.health < options.recoverTo || (policy().combat.recover !== "never" && bot.food < REGENERATION_HUNGER) || options.holdWhile?.()) && bot.health > 0 && !budget.exhausted) {
    options.signal.throwIfAborted();
    await options.defendIntruder();
    if (!usable()) return { kind: "exposed", ate };
    // Defensive cover can finish without healing. Keep the shell closed
    // through the attack, then hand back only if the caller's health floor is
    // met; never eat or wait for regeneration against an explicit prohibition.
    if (policy().combat.recover === "never") {
      if (options.holdWhile?.()) { await options.wait(1); continue; }
      return bot.health >= options.recoverTo
        ? { kind: "recovered", ate }
        : { kind: "held", stop: "prohibited", ate, reason: `Defence ended at health ${bot.health}; required ${options.recoverTo}, but recovery is prohibited.` };
    }
    if (bot.food < REGENERATION_HUNGER && !hasRegeneration(bot)) {
      const selection = selectPolicyFood(bot, policy().food);
      const food = selection.food;
      if (!food) {
        if (bot.health >= options.recoverTo) {
          if (!options.holdWhile?.()) break;
          await options.wait(1);
          continue;
        }
        return held(
          "unavailable",
          selection.withheld
            ? `nothing carried may be eaten: only uncooked ${selection.withheld.name} is carried and ${selection.verdict.reason}`
            : `nothing carried can restore it: no food, and hunger ${bot.food} is below the regeneration bar`,
        );
      }
      const exposed = new AbortController();
      const beforeEating = carriedCount(bot, food.name);
      const observe = () => {
        if (!usable() && !exposed.signal.aborted) {
          exposed.abort("Recovery position became unsafe while eating.");
          // This owner must stop the bite before returning to shield or contact defence.
          if (bot.usingHeldItem) bot.deactivateItem();
        }
      };
      bot.on("physicsTick", observe);
      try {
        options.releaseItemUse();
        const eaten = await eatFood(
          bot,
          { foodName: food.name },
          { signal: AbortSignal.any([options.signal, exposed.signal]) },
        );
        if (eaten.status === "succeeded") ate = food.name;
        else if (!exposed.signal.aborted) return held("eating_failed", `eating ${food.name} failed: ${eaten.error}`);
      } catch (cause) {
        options.signal.throwIfAborted();
        if (!exposed.signal.aborted) throw cause;
        // Consumption can be observed in the same packet turn as lost cover.
        if (carriedCount(bot, food.name) < beforeEating) ate = food.name;
      } finally {
        bot.off("physicsTick", observe);
      }
      if (exposed.signal.aborted) return { kind: "exposed", ate };
    }
    await options.wait(1);
  }
  if (bot.health > 0 && !usable()) return { kind: "exposed", ate };
  return bot.health >= options.recoverTo && !options.holdWhile?.()
    ? { kind: "recovered", ate }
    : held(
        "exhausted",
        `the ${Math.round(options.maximumMs / 1000)}-second hold ran out at health ${bot.health}; required ${options.recoverTo}${options.holdWhile?.() ? "; the threat still prevents leaving cover" : ""}`,
      );
}
