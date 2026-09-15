import { z } from "zod";
export const DESTROY_END_CRYSTAL = "destroy_end_crystal" as const;
export const DESTROY_END_CRYSTAL_DESCRIPTION =
  "Destroy one loaded end crystal with weapon auto, bow, or melee. Auto uses a carried permitted bow and arrow, otherwise melee. Bow refuses before movement when its weapon, ammunition, or policy permission is missing; melee never shoots, even while a bow and arrows are carried. Melee approach staircase (default) plans a reusable end-stone spiral staircase around the observed tower, reports the missing-block shortfall before building, and re-audits the same layout after interruption; approach pillar instead scaffolds straight up beside the tower to the same swing stance with carried scaffold blocks, which is faster and needs fewer blocks but leaves no walkable return path, so the descent digs back down through its own pillar. It uses the build_structure builder and never mines the tower: narrow towers are hit from the covered rim below the pedestal, wider ones from the tower top, where the pedestal still shields the lower body and the swing is refused unless the estimated blast damage after armor leaves health above critical_health. It then returns to the ground near its start while preserving the staircase. End-stone placement must be permitted by survival policy. Dragon defence may use policy-permitted enclosure and recovery with carried end stone or obsidian; successful defence resumes this same crystal and return route once the dragon has passed and the required health floor is met. Healing is not required when recovery is prohibited and health is sufficient. Unavailable or exhausted required recovery stops with its reason. Report phase measurements and observed crystal death or explosion. After a released shot loses observation, return to the recorded native tower and wait for fresh server updates; a loaded site verified empty also completes the action. Disappearance alone, route progress, or player death is not success. Does not choose another crystal.";
export const destroyEndCrystalInputSchema = z.strictObject({
  entity_id: z.number().int().nonnegative().describe("Currently observed end crystal entity ID."),
  weapon: z
    .enum(["auto", "bow", "melee"])
    .default("auto")
    .describe("Attack method. Auto prefers a permitted carried bow and arrow, then falls back to permitted melee."),
  approach: z
    .enum(["staircase", "pillar"])
    .default("staircase")
    .describe("Melee climb. staircase builds and reuses an end-stone spiral around the tower; pillar scaffolds straight up beside it with carried scaffold blocks and digs back down afterwards. Ignored for bow shots."),
});
