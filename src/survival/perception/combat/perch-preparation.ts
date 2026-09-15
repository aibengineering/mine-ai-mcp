import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { PerchObservation } from "./perch.js";

/** The combat controller retains one site across calls, never a claim that terrain is still safe. */
export class PerchPreparation {
  private site: { dimension: string; dragon: Bot["entity"]; target: Vec3; reached: Vec3 | null } | null = null;

  restore(observation: PerchObservation): void {
    if (this.site?.dimension !== observation.dimension || this.site.dragon !== observation.target) {
      this.site = null;
      return;
    }
    observation.preparationTarget ??= this.site.target.clone();
    observation.preparedPosition ??= this.site.reached?.clone() ?? null;
  }

  retain(observation: PerchObservation): void {
    if (!observation.target || !observation.preparationTarget) return;
    this.site = { dimension: observation.dimension, dragon: observation.target,
      target: observation.preparationTarget.clone(), reached: observation.preparedPosition?.clone() ?? null };
  }
}
