import { Answered } from "./answered.js";
import { Budgets } from "./budgets.js";

/** One connection's conclusions and currently owned budgets, shared by every executor. */
export interface SurvivalResources {
  readonly answered: Answered;
  readonly budgets: Budgets;
}

export function survivalResources(): SurvivalResources {
  return { answered: new Answered(), budgets: new Budgets() };
}
