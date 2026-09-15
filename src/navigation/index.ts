/**
 * The navigation library's public surface.
 *
 * Everything outside `src/navigation/` — actions, survival, the session, and
 * the goal-directed processes that sit above navigation — imports from here and
 * nowhere else. The engine below it (search, movement generation, route
 * execution, world adapters, telemetry sinks) is not caller vocabulary and is
 * deliberately absent.
 *
 * Runtime composition constructs one navigation runtime per bot. Route callers
 * hold that runtime; survival can also borrow the local steering primitives below
 * while its response has body authority from the foreground session.
 *
 * Reading order, if you are new here: this file, then `runtime.ts` and
 * `navigate.ts` for what a caller holds and what one call does; then
 * `orchestration/navigator.ts` and `orchestration/navigation-run.ts` for the
 * loop; then the pure planning layer beneath it — `goals/`, `movements/`,
 * `search/` — and the physical layer beside it, `execution/`; then
 * `mineflayer/`, where Minecraft finally appears; and last `processes/`, the
 * goal-directed callers — mining and building — that revise their goal while
 * a run is live.
 *
 * Interfaces here are ports: the engine states what it needs (`WorldView`,
 * `NavigationBot`, `Goal`) and lives against that statement, so "go to
 * definition" lands on the port. The production implementation is in
 * `mineflayer/` under a matching name (`MineflayerWorldView`,
 * `MineflayerBot`) and the test double in `test-support/navigation.ts`;
 * "go to implementations" lists both.
 */

// The per-bot runtime, and the physical ownership it arbitrates.
export type {
  BreakBlockInPlace,
  BreakBlockInPlaceOptions,
  BreakBlockInPlaceResult,
} from "./execution/in-place-break.js";
export { SupportedPositionController } from "./execution/supported-position-controller.js";
export { setSneaking } from "./mineflayer/sneak.js";
export { enterPortal, portalApproachGoal, type PortalBlock } from "./processes/portal-entry.js";
export { createNavigationRuntime, createMovements } from "./runtime.js";
export type { NavigationRuntime } from "./runtime.js";
export { centerOnCell, horizontalControlsToward, steeringPortFor } from "./steering/local-steering.js";
export { SupportedPositionHold } from "./steering/supported-position.js";
export { hasSupportedCorridor } from "./world/block-geometry.js";
export { isPassable, isHeadPassable, isSafeSupport } from "./world/block-geometry.js";

// The navigation transaction.
export { DEFAULT_CONTINUATION_SEARCH_LIMITS, DEFAULT_SEARCH_LIMITS } from "./navigate.js";
export type { Navigate, NavigateOptions, NavigationResult } from "./navigate.js";
export { describeCalculationFailure, type NavigationCalculationFailure } from "./orchestration/process-events.js";

// Goals: what a route is asked to satisfy.
export type { Goal } from "./goals/goal.js";
export {
  ASCENT_TICKS_PER_BLOCK,
  DESCENT_TICKS_PER_BLOCK,
  HORIZONTAL_TICKS_PER_BLOCK,
  advanceGoal,
  anyGoal,
  customGoal,
  exactBlockGoal,
  itemPickupGoal,
  nearEntityGoal,
  nearGoal,
  nearXzGoal,
  occupyGoal,
  safeFromEntitiesGoal,
} from "./goals/index.js";
export { packKey, type BlockPosition, type WorldView } from "./world/world.js";

// Movement policy: what a route may do, and what it costs.
export { STANDARD_SCAFFOLD_ITEMS, TERRAIN_BREAK_PENALTY } from "./mineflayer/movement-policy.js";
export { observeMineflayerBlock } from "./mineflayer/world.js";
export type { MineflayerBlock } from "./mineflayer/world.js";
export { BREAK_OPENS_INTO_LIQUID } from "./movements/policy.js";
export type { MovementPolicy } from "./movements/policy.js";
export type { StepField, StepFieldProvider } from "./step-field.js";

export type { NavigationEvent } from "./telemetry/index.js";

export { canOccupyWater } from "./mineflayer/water.js";

export { canAccessLiquid, liquidAccessGoal } from "./goals/liquid-access.js";
