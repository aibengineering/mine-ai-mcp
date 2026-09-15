import { z } from "zod";
export const SHOOT_DRAGON = "shoot_dragon" as const;
export const SHOOT_DRAGON_DESCRIPTION =
  "Fire at most one full-charge bow shot at a loaded flying Ender Dragon, then report observed dragon health loss or an unconfirmed/missed shot. Repeat to keep attacking with a bow. Requires a permitted carried bow and arrows; respects combat.bow. Uses current footing, tracks motion during the draw, and leads the estimated body hitbox with arrow drag/gravity and terrain clearance. Waits up to 200 aiming ticks for a usable flight shot, then returns the blocker so you can reposition. hitbox_margin insets the body estimates: higher values conserve arrows by requiring a safer predicted hit; sudden turns and arrow spread can still cause misses. This setting never changes dragon swoop detection or evasion distances. Survival defense may reposition or interrupt the action; an already released arrow is observed on resumption without firing another. Sitting dragons are immune to arrows: use attack_dragon_perch or wait for takeoff. No perch preparation, melee, tower construction or automatic pursuit. Normal arrow damage does not clear a stale native strafe target, but it can damage a stuck flying dragon. A released arrow or unloaded dragon is not a confirmed hit or kill.";
export const shootDragonInputSchema = z.strictObject({
  entity_id: z.number().int().nonnegative().describe("Currently observed Ender Dragon entity ID."),
  hitbox_margin: z.number().min(0).max(1.25).default(0.5).describe(
    "Inset in blocks from each face of the estimated 5x3 body hitbox. Higher is more selective and may wait longer; 0 uses the full body. Requires the shot to fit recent velocity and turn extrapolations. Independent of swoop evasion; not a guaranteed hit probability.",
  ),
});
