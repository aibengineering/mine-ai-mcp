/**
 * What the model may change about how the bot gets around: which blocks it may
 * place as scaffold, whether water can save or carry a fall, and how much it
 * shies away from hostiles. Survival owns the edits (it is the model's one policy
 * surface) and hands navigation the live result per bot (see `policy-provider.ts`);
 * navigation only reads. Pure data, so the survival policy can build on it.
 */
export interface NavigationPolicy {
  readonly scaffold_blocks: readonly string[];
  readonly bucket_fall_save: boolean;
  readonly bucket_drops: boolean;
  readonly hostile_avoidance_multiplier: number;
}

export const DEFAULT_SCAFFOLD_BLOCKS = Object.freeze([
  "dirt",
  "cobblestone",
  "cobbled_deepslate",
  "netherrack",
  "basalt",
  "end_stone",
]);

export const DEFAULT_NAVIGATION_POLICY: Readonly<NavigationPolicy> = Object.freeze({
  scaffold_blocks: DEFAULT_SCAFFOLD_BLOCKS,
  hostile_avoidance_multiplier: 1,
  bucket_fall_save: true,
  bucket_drops: true,
});
