import type { Bot } from "mineflayer";
import type { Position3 } from "../../../utils/index.js";
import type { HostileResponse, HostileThreat } from "../../policy/combat/response.js";
import type { deflectFireball } from "../../responses/deflect.js";
import type { HideResult } from "../../responses/hide.js";
import type { CombatOutcome, CombatStyle } from "./contract.js";
export interface EncounterEvidence {
  readonly reason: string;
  readonly threats: readonly HostileThreat[];
  readonly healthBefore: number;
  readonly healthAfter: number;
  readonly finalPosition: Position3;
  readonly finalDistances: readonly { readonly id: number; readonly distance: number }[];
  readonly killedTargetIds: readonly number[];
  readonly attacks: number;
  readonly combatStyles: readonly CombatStyle[];
  /** Concrete held items used to deal damage; `hand` means deliberately empty. */
  readonly weaponsUsed: readonly string[];
  /** Exact-target swing animations observed while shield use was requested. */
  readonly shieldRaisedSwings: number;
  /** Bow draws by the target that a carried shield was raised against. */
  readonly projectileGuards: number;
  /** Explosions the server announced while the response held the body. */
  readonly explosions: number;
}
export type FightResponseResult = EncounterEvidence & {
  readonly response: "fight";
  readonly result: CombatOutcome | { readonly kind: "contact_ended" };
};
export type EvadeResponseResult = EncounterEvidence & {
  readonly response: "evade";
  readonly result: { readonly kind: "separated" } | { readonly kind: "exhausted" | "failed"; readonly reason: string };
};
export type HideResponseResult = EncounterEvidence & { readonly response: "hide"; readonly result: HideResult };
export type DeflectResponseResult = EncounterEvidence & {
  readonly response: "deflect";
  readonly result: Awaited<ReturnType<typeof deflectFireball>>;
};
export type HostileResponseResult =
  FightResponseResult | EvadeResponseResult | HideResponseResult | DeflectResponseResult;
export type HostileSettlement = {
  readonly response: HostileResponse["kind"];
  readonly evidence: EncounterEvidence;
  readonly physical: HostileResponseResult | null;
} & (
  | { readonly kind: "completed"; readonly physical: HostileResponseResult }
  | { readonly kind: "cancelled" | "bot_died" | "failed"; readonly reason: string }
);
const FIGHT_REASON = "healthy";
function distance(left: Position3, right: Position3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
export function encounterBaseline(bot: Bot, request: HostileResponse, healthBefore: number) {
  return {
    response: request.kind,
    reason: request.kind === "fight" ? FIGHT_REASON : request.reason,
    threats: [...request.threats],
    healthBefore,
    healthAfter: bot.health,
    finalPosition: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    finalDistances: request.threats.map((threat) => ({
      id: threat.id,
      distance:
        bot.entities[threat.id]?.position.distanceTo(bot.entity.position) ??
        distance(threat.position, bot.entity.position),
    })),
  };
}
