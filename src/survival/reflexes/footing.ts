import type { CombatController } from "../control/combat/contract.js";

import type { ReflexDriver } from "../control/driver.js";
import { decideFootingResponse } from "../policy/environment.js";
import type { FootingRecovery } from "../responses/footing.js";

/** Combat uses the same impulse history internally; other owners yield to its landing. */
export function attachFootingReflex(
  driver: ReflexDriver,
  combat: Pick<CombatController, "activeEngagement">,
  recovery: Pick<FootingRecovery, "needed" | "recover"> & Partial<Pick<FootingRecovery, "bucketNeeded" | "snapshot">>,
  releaseNavigation: (reason: string) => void,
  protection?: { maintain(): Promise<void>; release(): void },
): AsyncDisposable {
  const failureReason = () => {
    const snapshot = recovery.snapshot?.();
    const water = snapshot?.water;
    return water
      ? `[WATER_LANDING_FAILED] ${water.reason ?? "Water protection and bucket recovery were not both confirmed."} Pours: ${water.pours}; water recovered: ${water.waterRecovered}.`
      : snapshot?.reason ?? "A supported landing was not observed.";
  };
  return driver.register({
    name: "recover_footing",
    sense: () => {
      if (!recovery.needed) return null;
      const facts = {
        unsafeImpulse: recovery.snapshot ? recovery.snapshot()?.phase === "pending" : true,
        combatActive: combat.activeEngagement() !== null,
        bucketNeeded: recovery.bucketNeeded ?? false,
      };
      return { kind: "observed", danger: facts, evidence: facts };
    },
    decide: decideFootingResponse,
    facts: () => ({
      capability: "footing",
      response: "recover_footing",
      scope: "pending_impulse",
      facts: () => ({ needed: recovery.needed }),
      permissions: () => null,
    }),
    releaseAfterAdmission: () => releaseNavigation("Footing recovery is taking control of the airborne body"),
    act: async (_response, signal) => {
      try { return await recovery.recover(signal, protection?.maintain); }
      finally { protection?.release(); }
    },
    continuation: (outcome) =>
      outcome === "landed" ? { kind: "resume" } : { kind: "return", reason: failureReason() },
    failure: (outcome) =>
      outcome === "failed" ? { kind: "landing_failed", why: failureReason() } : null,
    describe: (outcome) => {
      const water = recovery.snapshot?.()?.water;
      return { kind: outcome, water: water ? { ...water, cell: water.cell ? { ...water.cell } : null } : null };
    },
  });
}
