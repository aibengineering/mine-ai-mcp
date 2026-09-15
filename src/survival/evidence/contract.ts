import { z } from "zod";
import { policySnapshotSchema } from "../policy/contract.js";
import type { Facts } from "../state/answered.js";

export const factsSchema: z.ZodType<Facts, Facts> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(factsSchema), z.record(z.string(), factsSchema)]),
);

export const bodyAbortCauseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preempted"), by: z.string() }),
  z.strictObject({ kind: z.literal("policy_changed"), revision: z.string() }),
  z.strictObject({ kind: z.literal("cancelled"), by: z.enum(["model", "runtime"]) }),
  z.strictObject({ kind: z.literal("connection_lost") }),
  z.strictObject({ kind: z.literal("death") }),
  z.strictObject({ kind: z.literal("dimension_changed"), from: z.string(), to: z.string() }),
]);

export const requestSchema = z.strictObject({
  id: z.string(),
  requestId: z.number().nullable(),
  action: z.string(),
  admittedAt: z.number(),
  objective: z.unknown(),
  observationError: z.string().optional(),
  state: z.union([
    z.strictObject({ kind: z.enum(["admitted", "running", "resuming", "returned"]) }),
    z.strictObject({ kind: z.literal("suspended"), by: z.string(), cause: bodyAbortCauseSchema }),
  ]),
  evidence: z
    .strictObject({
      baseline: factsSchema,
      checkpoint: factsSchema,
      completion: z.strictObject({ kind: z.enum(["event", "current"]), observed: z.boolean(), owes: z.string() }),
    })
    .nullable(),
}).meta({ id: "MineAiRequest" });

export const survivalStatusSchema = z.strictObject({
  summary: z.enum(["safe", "unknown", "threatened", "responding", "standing_down", "dead"]),
  request: requestSchema.nullable(),
  owner: z.strictObject({
    current: z.string().nullable(),
    reserved: z.string().nullable(),
    connected: z.boolean(),
    transfer: z.strictObject({ from: z.string(), to: z.string(), cause: bodyAbortCauseSchema }).nullable(),
  }),
  dangers: z.array(
    z.strictObject({
      reflex: z.string(),
      evidence: factsSchema,
      selected: z.boolean(),
      unresolved: z.boolean(),
      observedAt: z.number().nullable(),
      stale: z.boolean(),
    }),
  ),
  response: z
    .strictObject({
      capability: z.string(),
      kind: z.string(),
      phase: z.string(),
      phaseTicks: z.number().nullable(),
      startedAt: z.number().nullable(),
    })
    .nullable(),
  decisions: z.array(z.strictObject({ reflex: z.string(), decision: factsSchema })),
  budgets: z.array(
    z.strictObject({
      name: z.string(),
      scope: z.string(),
      mode: z.enum(["attempt", "progress"]),
      unit: z.enum(["milliseconds", "ticks"]),
      limit: z.number(),
      spent: z.number(),
      remaining: z.number(),
      exhaustion: z.string(),
      progress: z.string().nullable(),
    }),
  ),
  answered: z.array(
    z.strictObject({
      id: z.number(),
      capability: z.string(),
      response: z.string(),
      scope: z.string(),
      facts: factsSchema,
      consumed: factsSchema,
      failure: z.strictObject({ kind: z.string(), why: z.string() }),
      since: z.number(),
      temporal: z.strictObject({ premise: z.string(), expiresAt: z.number(), why: z.string() }).nullable(),
    }),
  ),
  observations: z.strictObject({ missing: z.array(z.string()), stale: z.array(z.string()) }),
  policy: policySnapshotSchema,
  vitals: z.strictObject({ health: z.number(), food: z.number(), air: z.number().nullable(), inWater: z.boolean() }),
  runtime: z.strictObject({
    liveness: z.enum(["observed_in_process", "disconnected"]),
    observedAt: z.number(),
    physicsObservedAt: z.number().nullable(),
  }),
});
// Shared definitions keep the generated wait-result union compact. These
// module-owned schemas have stable IDs; individual connections register none.
z.globalRegistry.add(survivalStatusSchema, { id: "MineAiSurvivalStatus" });
export type SurvivalStatus = z.output<typeof survivalStatusSchema>;

export const survivalReceiptSchema = z.strictObject({
  kind: z.enum(["danger", "decision", "claim", "phase", "outcome"]),
  source: z.string(),
  evidence: factsSchema,
  status: survivalStatusSchema,
});
export type SurvivalReceipt = z.output<typeof survivalReceiptSchema>;
