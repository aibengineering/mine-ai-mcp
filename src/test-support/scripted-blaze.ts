/** Deterministic attack schedule for LOS/cancellation tests; physical damage remains a Mine Labs assertion. */
export class ScriptedBlaze {
  #step = 0;
  #remaining = 0;
  charging = false;
  shots = 0;

  tick(hasSight: boolean): "charge" | "shot" | "rest" | null {
    this.#remaining--;
    // Losing sight does not spend an attack step. Reopening a wall can
    // release an overdue shot immediately, even after a long hidden wait.
    if (!hasSight || this.#remaining > 0) return null;
    this.#step++;
    if (this.#step === 1) {
      this.charging = true;
      this.#remaining = 60;
      return "charge";
    }
    if (this.#step <= 4) {
      this.shots++;
      this.#remaining = 6;
      return "shot";
    }
    this.#step = 0;
    this.charging = false;
    this.#remaining = 100;
    return "rest";
  }
}
