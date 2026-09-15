import type { Vec3 } from "vec3";
import type { WorldView } from "../../../navigation/world/world.js";
import type { AnsweredScope, Facts } from "../../state/answered.js";

/** A failed geometry attempt watches only its declared search region. Subscriptions
 * begin when Answered captures settlement, after the attempt's own block edits. */
export function geometryAnswer(world: WorldView, origin: Vec3, radius: number, scope: AnsweredScope): AnsweredScope {
  let changed: Facts = null;
  let unsubscribe: (() => void) | null = null;
  return {
    ...scope,
    facts: () => {
      unsubscribe ??= world.subscribe(({ position, before, after }) => {
        if (
          Math.max(Math.abs(position.x - origin.x), Math.abs(position.y - origin.y), Math.abs(position.z - origin.z)) >
          radius
        )
          return;
        if (
          before.kind === after.kind &&
          (before.kind !== "loaded" || after.kind !== "loaded" || before.stateId === after.stateId)
        )
          return;
        changed = { ...position, state: after.kind === "loaded" ? after.stateId : null };
      });
      return { region: { x: origin.x, y: origin.y, z: origin.z, radius }, changed, premises: scope.facts() };
    },
    dispose: () => {
      unsubscribe?.();
      unsubscribe = null;
      scope.dispose?.();
    },
  };
}
