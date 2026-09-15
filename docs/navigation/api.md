# Navigation API reference

The public surface exported by the navigation library through [src/navigation/index.ts](../../src/navigation/index.ts).

All external callers interact with these exports. Internal engine modules remain private to the package.

## The per-bot runtime and physical ownership

These exports construct the per-bot runtime and manage exclusive access to physical bot controls.

| Export                                                                         | Kind      | Source                                                                          | Description                                                                                                                      |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`createNavigationRuntime`](../../src/navigation/runtime.ts)                   | Function  | [runtime.ts](../../src/navigation/runtime.ts)                                   | Constructs the exclusive navigation runtime for one connected Mineflayer bot.                                                    |
| [`createMovements`](../../src/navigation/runtime.ts)                     | Function  | [runtime.ts](../../src/navigation/runtime.ts)                                   | Builds the default movement policy configured with Mineflayer dig times, harvest tools, and protected blocks.                    |
| [`NavigationRuntime`](../../src/navigation/runtime.ts)                         | Interface | [runtime.ts](../../src/navigation/runtime.ts)                                   | The runtime instance holding route navigation, local steering, in-place digging, lifecycle controls, and telemetry subscription. |
| [`LocalSteeringOptions`](../../src/navigation/runtime.ts)                      | Type      | [runtime.ts](../../src/navigation/runtime.ts)                                   | Parameters for driving local steering toward a point, omitting internal engine signals.                                          |
| [`SteerToward`](../../src/navigation/runtime.ts)                               | Type      | [runtime.ts](../../src/navigation/runtime.ts)                                   | Function signature for local steering operations driven through the bot actuator.                                                |
| [`BreakBlockInPlace`](../../src/navigation/execution/in-place-break.ts)        | Type      | [execution/in-place-break.ts](../../src/navigation/execution/in-place-break.ts) | Function signature for breaking an adjacent block without planning a path.                                                       |
| [`BreakBlockInPlaceOptions`](../../src/navigation/execution/in-place-break.ts) | Interface | [execution/in-place-break.ts](../../src/navigation/execution/in-place-break.ts) | Target block coordinates, movement policy, and cancellation signal for in-place breaking.                                        |
| [`BreakBlockInPlaceResult`](../../src/navigation/execution/in-place-break.ts)  | Type      | [execution/in-place-break.ts](../../src/navigation/execution/in-place-break.ts) | Discriminated union reporting either `"broken"` or `"failed"` with an explanatory reason.                                        |

## The navigation transaction

These exports define the route transaction, search limits, and failure shapes.

| Export                                                                                 | Kind      | Source                                                                                  | Description                                                                                                |
| -------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`DEFAULT_SEARCH_LIMITS`](../../src/navigation/navigate.ts)                            | Constant  | [navigate.ts](../../src/navigation/navigate.ts)                                         | Inline search limits: 500 ms primary timeout, 2,000 ms failure timeout, and 16-block segment length.       |
| [`DEFAULT_CONTINUATION_SEARCH_LIMITS`](../../src/navigation/navigate.ts)               | Constant  | [navigate.ts](../../src/navigation/navigate.ts)                                         | Plan-ahead search limits: 4,000 ms primary timeout, 5,000 ms failure timeout, and 16-block segment length. |
| [`Navigate`](../../src/navigation/navigate.ts)                                         | Type      | [navigate.ts](../../src/navigation/navigate.ts)                                         | Function signature for executing one complete navigation request.                                          |
| [`NavigateOptions`](../../src/navigation/navigate.ts)                                  | Interface | [navigate.ts](../../src/navigation/navigate.ts)                                         | Options supplied to a navigation call.                                                                     |
| [`NavigationResult`](../../src/navigation/navigate.ts)                                 | Type      | [navigate.ts](../../src/navigation/navigate.ts)                                         | Settled outcome of a navigation call, reporting completion status, reason, and elapsed duration.           |
| [`NavigationCalculationFailure`](../../src/navigation/orchestration/process-events.ts) | Type      | [orchestration/process-events.ts](../../src/navigation/orchestration/process-events.ts) | Failure report for inline path calculations, detailing missing paths or exceeded search bounds.            |

### How `NavigateOptions` configures a route

The caller passes options to [`navigate`](../../src/navigation/navigate.ts) to define what route to build and how to manage runtime decisions:

| Field                  | Type             | Purpose                                                                                 |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `movements`            | `MovementPolicy` | Required rules specifying allowed jumps, digging, scaffolding, and break costs.         |
| `goal`                 | `Goal`           | Required spatial objective the route must satisfy.                                      |
| `onArrival`            | Function         | Optional hook invoked when a spatial goal is reached; permits continuing the run.       |
| `onCalculationFailure` | Function         | Optional hook invoked when an inline search fails; permits revising the goal.           |
| `timeoutMs`            | Number           | Optional maximum duration in milliseconds before stopping the route.                    |
| `signal`               | `AbortSignal`    | Optional cancellation signal for the overall task; throws when triggered.               |
| `stopSignal`           | `AbortSignal`    | Optional signal that stops only this navigation run without aborting the parent action. |
| `searchLimits`         | `SearchLimits`   | Optional override for primary timeout, failure timeout, or maximum search radius.       |

### What `NavigationResult` reports

A settled route returns a [`NavigationResult`](../../src/navigation/navigate.ts) object with these fields:

| Field       | Type   | Values                       | Meaning                                                                     |
| ----------- | ------ | ---------------------------- | --------------------------------------------------------------------------- |
| `status`    | String | `"completed"` or `"stopped"` | Indicates whether the bot arrived at the goal or stopped early.             |
| `elapsedMs` | Number | Non-negative integer         | Total wall-clock time spent on the navigation transaction.                  |
| `reason`    | String | Explanatory message          | Explains why the run stopped early; omitted when `status` is `"completed"`. |

## Goals define route objectives

These exports construct spatial goals and provide metric constants for search estimates.

| Export                                                              | Kind      | Source                                                | Description                                                                                 |
| ------------------------------------------------------------------- | --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`HORIZONTAL_TICKS_PER_BLOCK`](../../src/navigation/goals/index.ts) | Constant  | [goals/index.ts](../../src/navigation/goals/index.ts) | Base estimate of 4 ticks per block for horizontal travel.                                   |
| [`ASCENT_TICKS_PER_BLOCK`](../../src/navigation/goals/index.ts)     | Constant  | [goals/index.ts](../../src/navigation/goals/index.ts) | Base estimate of 8 ticks per block for ascending movements.                                 |
| [`DESCENT_TICKS_PER_BLOCK`](../../src/navigation/goals/index.ts)    | Constant  | [goals/index.ts](../../src/navigation/goals/index.ts) | Base estimate of 4.5 ticks per block for descending movements.                              |
| [`exactBlockGoal`](../../src/navigation/goals/index.ts)             | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal satisfied only at the exact integer coordinate of a target block.            |
| [`nearGoal`](../../src/navigation/goals/index.ts)                   | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal satisfied within a 3D spherical radius of a target position.                 |
| [`nearXzGoal`](../../src/navigation/goals/index.ts)                 | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal satisfied within a 2D cylindrical radius in the horizontal plane.            |
| [`occupyGoal`](../../src/navigation/goals/index.ts)                 | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal satisfied by standing in a block cell or directly below it.                  |
| [`anyGoal`](../../src/navigation/goals/index.ts)                    | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Combines multiple goals, satisfied when the first active goal is reached.                   |
| [`customGoal`](../../src/navigation/goals/index.ts)                 | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Builds a goal from custom satisfaction and heuristic callbacks.                             |
| [`nearEntityGoal`](../../src/navigation/goals/index.ts)             | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal tracking a live entity's current position within a specified range.          |
| [`safeFromEntitiesGoal`](../../src/navigation/goals/index.ts)       | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a retreat goal requiring a minimum separation from threat entities.                 |
| [`itemPickupGoal`](../../src/navigation/goals/index.ts)             | Function  | [goals/index.ts](../../src/navigation/goals/index.ts) | Creates a goal satisfied by standing within the pickup volume of a dropped item.            |
| [`Goal`](../../src/navigation/goals/goal.ts)                        | Interface | [goals/goal.ts](../../src/navigation/goals/goal.ts)   | Interface for objects that take a world observation and produce a resolved goal: the question frozen for that observation. |
| [`BlockPosition`](../../src/navigation/world/world.ts)              | Type      | [world/world.ts](../../src/navigation/world/world.ts) | Integer coordinates `{ x: number, y: number, z: number }` for world blocks.                 |

## Movement policies evaluate transitions

These exports define what physical actions are permitted and how block observations are formatted.

| Export                                                                          | Kind      | Source                                                                              | Description                                                                        |
| ------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`STANDARD_SCAFFOLD_ITEMS`](../../src/navigation/mineflayer/movement-policy.ts) | Constant  | [mineflayer/movement-policy.ts](../../src/navigation/mineflayer/movement-policy.ts) | Default preference list used by `navigation.scaffold_blocks`.                       |
| [`observeMineflayerBlock`](../../src/navigation/mineflayer/world.ts)            | Function  | [mineflayer/world.ts](../../src/navigation/mineflayer/world.ts)                     | Describes one block state as the compact, position-free observation planning reads. |
| [`MineflayerBlock`](../../src/navigation/mineflayer/world.ts)                   | Type      | [mineflayer/world.ts](../../src/navigation/mineflayer/world.ts)                     | Non-nullable return type of Mineflayer's `bot.blockAt` method.                     |
| [`MovementPolicy`](../../src/navigation/movements/policy.ts)                    | Interface | [movements/policy.ts](../../src/navigation/movements/policy.ts)                     | Policy configuration for movement permissions, step evaluation, and digging rules. |

## Telemetry streams run events

The library emits structured telemetry events through one event union.

| Export                                                       | Kind | Source                                                        | Description                                                                |
| ------------------------------------------------------------ | ---- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`NavigationEvent`](../../src/navigation/telemetry/index.ts) | Type | [telemetry/index.ts](../../src/navigation/telemetry/index.ts) | Discriminated union of thirteen navigation lifecycle and execution events. |
