import { z } from "zod";
export const ATTACK_DRAGON_PERCH = "attack_dragon_perch" as const;
export const ATTACK_DRAGON_PERCH_DESCRIPTION =
  "Handle one Ender Dragon perch window: approach the estimated settled head, attack upward with a carried melee weapon and retain control until takeoff danger clears on supported ground. Pursuit continues through scanning while current head and hazard observations permit it. Evades clouds, projectiles and contact. Call prepare_dragon_perch separately during flight to open and verify a reusable low approach; attack and retreat never repeat general preparation. The selected site is retained across requests, with current routes and hazards rechecked. A completed perch is not a kill or proof of damage: results report dragon health, confirmed damage, first-damage timing, stage ticks and approach blockers. Cancellation remains available while waiting. Use shoot_dragon for flight attacks, including a prolonged strafing phase after a player death; cancel a waiting perch action before switching.";
export const attackDragonPerchInputSchema = z.strictObject({
  entity_id: z.number().int().nonnegative().describe("Currently observed Ender Dragon entity ID."),
});
