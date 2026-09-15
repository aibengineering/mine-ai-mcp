/** Scenario-only progress: healing and repeated sightings cannot keep a stuck fight alive. */
export class DragonDamageProgress {
  constructor(
    public lowestHealth: number | null,
    private lastDamageAt: number,
    private readonly stallMs: number,
  ) {}

  observe(health: number | null, now: number): "progressing" | "stalled" {
    if (health !== null && (this.lowestHealth === null || health < this.lowestHealth)) {
      this.lowestHealth = health;
      this.lastDamageAt = now;
    }
    // Native death animation and portal activation are allowed to finish.
    return this.lowestHealth !== 0 && now - this.lastDamageAt >= this.stallMs ? "stalled" : "progressing";
  }
}
