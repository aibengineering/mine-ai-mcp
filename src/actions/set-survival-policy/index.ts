import {
  describeLifetime,
  policyEditSchema,
  policySnapshotSchema,
  type PolicySnapshot,
} from "../../survival/policy/contract.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { defineAction, actionResultSchema } from "../action.js";
import {
  SET_SURVIVAL_POLICY,
  SET_SURVIVAL_POLICY_DESCRIPTION,
  setSurvivalPolicyInputSchema,
} from "./contract.js";

export function formatSurvivalPolicy(policy: PolicySnapshot): string {
  const overrides = policy.overrides.length
    ? policy.overrides.map(
        (override) =>
          `- \`${override.path}\` = ${JSON.stringify(override.value)} (${describeLifetime(override.lifetime)}; ${override.reason})`,
      )
    : ["- none; every field is at its default."];
  return [
    `Survival policy ${policy.revision}: ${policy.lastChange}`,
    "",
    "Overrides:",
    ...overrides,
    "",
    `Effective: ${JSON.stringify(policy.effective)}`,
    "",
    `Physical reconciliation: ${policy.settling ? "settling" : "settled"}.`,
  ].join("\n");
}

/** One control surface for every reflex permission; remains available while a response owns the body. */
export function createSetSurvivalPolicyAction(policy: SurvivalPolicyState) {
  const resultSchema = actionResultSchema({ policy: policySnapshotSchema });
  return defineAction({
    name: SET_SURVIVAL_POLICY,
    description: SET_SURVIVAL_POLICY_DESCRIPTION,
    inputSchema: setSurvivalPolicyInputSchema,
    resultSchema,
    parse: (input: unknown) => policyEditSchema.parse(input),
    execution: { kind: "control" },
    formatResult: (result) => formatSurvivalPolicy(result.policy),
    execute: async (request) => {
      try {
        return { status: "succeeded" as const, policy: await policy.edit(request) };
      } catch (error) {
        return { status: "failed" as const, error: String(error), policy: policy.snapshot() };
      }
    },
  });
}
