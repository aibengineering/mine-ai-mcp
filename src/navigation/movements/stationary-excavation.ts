import type { GeneratedMovement, PlanningState } from "./catalogue.js";
import type { Excavation } from "./excavation.js";
import { stateMatcher, type PlannedStep } from "./movement.js";
import { blockLabel } from "../world/world.js";

/** Execute priced excavation from one supported stance without travelling away. */
export function stationaryExcavation(
  state: PlanningState,
  excavation: Extract<Excavation, { kind: "prepared" }>,
): GeneratedMovement {
  const feet = state.node.feet;
  const cleared = excavation.digs.flatMap((dig) => [dig.position, ...dig.brings]);
  let overlay = state.overlay;
  for (const position of cleared) overlay = overlay.apply({ kind: "break", position, stateId: 0 });
  const total = excavation.breakTicks + excavation.breakPenalty;
  return {
    to: feet,
    remainingScaffolds: state.node.remainingScaffolds,
    state: { node: { ...state.node, overlayId: overlay.identity }, overlay },
    cost: total,
    get step(): PlannedStep {
      return {
        id: `excavate:${blockLabel(feet)}`,
        // A zero-distance walk uses the existing executor's interaction
        // and settled-arrival lifecycle; it adds no travel cost.
        kind: "walk",
        from: feet,
        to: feet,
        validArrivals: [feet],
        preconditions: excavation.digs.map((dig) => ({
          position: dig.position,
          expected: stateMatcher(dig.stateId),
        })),
        operations: [
          ...excavation.digs.map((dig) => ({
            kind: "break" as const,
            position: dig.position,
            expectedStateId: dig.stateId,
            toolType: dig.toolType,
            brings: dig.brings,
          })),
          { kind: "move", movement: "walk", target: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 } },
        ],
        effects: cleared.map((position) => ({ kind: "break", position, stateId: 0 })),
        cost: {
          expectedTicks: excavation.breakTicks,
          breakPenalty: excavation.breakPenalty,
          placementPenalty: 0,
          hazardPenalty: 0,
          total,
        },
      };
    },
  };
}
