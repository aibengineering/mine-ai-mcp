# Telemetry and diagnosis

Navigation runs emit structured events describing planning progress, execution phases, and world changes.

Diagnostic tools capture these events to inspect route decisions and isolate physical failures.

## Runs emit thirteen structured event kinds

The [`NavigationEvent`](../../src/navigation/telemetry/index.ts) type in [telemetry/index.ts](../../src/navigation/telemetry/index.ts) models every transition in a navigation run. The runtime publishes events through its `onEvent` subscriber.

| Event kind           | Trigger condition                            | Key data fields                                   |
| -------------------- | -------------------------------------------- | ------------------------------------------------- |
| `run_started`        | A new navigation run begins.                 | `runId`, `atMs`                                   |
| `search_started`     | An incremental A* search begins.             | `searchId`, `reason`, `goal`                      |
| `search_slice`       | A compute slice finishes exploring nodes.    | `visited`, `generated`, `computeMs`, `checkpoint` |
| `route_committed`    | A path plan is accepted for execution.       | `planId`, `steps`                                 |
| `step_started`       | A planned step begins execution.             | `planId`, `stepId`, `movement`                    |
| `step_phase`         | A step transitions phase.                    | `stepId`, `phase`                                 |
| `step_completed`     | A step reaches its destination cell.         | `stepId`, `movement`                              |
| `step_failed`        | A step fails physically or times out.        | `stepId`, `movement`, `observation`               |
| `pinned_body`        | The body is held under a ceiling it does not fit beneath. | `cell`, `released`, `observation`      |
| `world_change`       | An observed block change is classified.      | `classification`                                  |
| `goal_arrived`       | The bot arrives at a satisfying goal cell.   | `result`                                          |
| `calculation_failed` | An inline search fails to find a path.       | `failure`, `result`                               |
| `cleanup_completed`  | Run resources and timers are released.       | `runId`, `atMs`                                   |
| `run_settled`        | The run concludes and reports final outcome. | `outcome`                                         |

Step phase events transition through six distinct states: `aligning`, `breaking`, `placing`, `activating`, `moving`, and `confirming`.

## The telemetry action streams events to host logs

The MCP action [`debug_set_pathfinder_telemetry`](../../src/actions/debug-set-pathfinder-telemetry/contract.ts) enables streaming JSON events directly to standard output.

Defined in [actions/debug-set-pathfinder-telemetry](../../src/actions/debug-set-pathfinder-telemetry/debug-set-pathfinder-telemetry.ts), this control action is available when debug tools are enabled. It can be invoked even while a foreground task owns the bot.

When enabled, the action subscribes to the runtime's event stream and writes formatted log lines:

```text
[mine-ai-mcp] pathfinder_event {"kind":"step_started","runId":"navigation-1","planId":"plan-1","stepId":"step-1","movement":"walk","atMs":1725330000000}
```

Disabling the action unsubscribes the listener cleanly.

## The block highlighter renders visual paths

The external library `@aibengineering/minecraft-block-highlighter` provides in-game spatial visualisations.

In [server/runtime-host.ts](../../src/server/runtime-host.ts), the runtime attaches the block highlighter to the bot on connection. The highlighter serves an HTTP endpoint on `/debug/api/highlights` through the host's loopback port.

Clients such as the AI Observer NeoForge mod poll this endpoint to draw 3D bounding boxes and route paths in the Minecraft world view.

Navigation remains decoupled from the visual highlighter. Navigation emits structured [`NavigationEvent`](../../src/navigation/telemetry/index.ts) objects into runtime listeners. The host and action layers attach visualizers when required.

## Telemetry guides route diagnosis

When a bot fails to reach a goal or takes an unexpected detour, follow this diagnosis procedure:

### 1. Enable diagnostic logging

Start the host with `--debug-execute-javascript` to enable the debug actions. Call the `debug_set_pathfinder_telemetry` tool:

```json
{
  "enabled": true
}
```

Stream the host process logs to observe pathfinder events in real time.

### 2. Trace the event sequence

Examine the logged telemetry events in chronological order:

1. **Search volume**: Inspect `search_slice` events. If `visited` counts rise into thousands without a `route_committed` event, the goal may be inaccessible or require unavailable scaffolding.
2. **Invalidations**: Inspect `world_change` events. If `invalidating` changes occur repeatedly, external entities or flowing liquids are modifying blocks along the committed route.
3. **Execution stalls**: Inspect `step_phase` and `step_failed` events. If movement repeatedly fails in the `moving` phase, check for block collision mismatches or missing jump headroom.
4. **No progress**: If the run settles with `no_progress`, check whether repeated movement failures or recurring search states triggered the loop guard.

### 3. Reproduce in an isolated scenario

Reproduce and verify problematic routes using dedicated Mine Labs scenarios in [scenarios/flat/pathfinder/](../../scenarios/flat/pathfinder/):

```bash
bunx --bun mine-labs run scenarios/flat/pathfinder/cavern-ore-return.yaml --out .mine-labs/debug --repeat 1
```

Representative test scenarios cover common physical challenges:

- `cavern-ore-return.yaml`: Long underground journeys requiring partial route continuation.
- `lateral-lava-tunnel.yaml`: Tunnelling through stone adjacent to flowing lava hazards.
- `obstacle-course-parkour.yaml`: Two-block to four-block gap jumps over voids.
- `long-underwater-exit.yaml`: Swimming and surfacing through deep water columns.
- `house-door-exit.yaml`: Doorway opening and obstacle clearance.

## Measuring the search

Every `search_slice` event carries `computeMs`. The scenario trace summary
reports the search rate in visited nodes per millisecond for the run. Use these
measurements to understand how much work fits within the search budget.

**Where the time goes.** Profile with Bun, which runs the TypeScript directly and reports real source lines and named native frames:

```bash
bun --cpu-prof-md path/to/script.ts   # writes CPU.<date>.<pid>.md into the working directory
bun --heap-prof-md path/to/script.ts  # writes Heap.<date>.<pid>.md: retained types and counts
```

Run from a scratch directory so the reports land there. A search-only script needs a `MemoryWorld`, a resolved goal, and an `IncrementalSearch` advanced with an unbounded slice budget until it stops; the exhaust case, a goal that floats in the air over a wide flat world, is the one that stresses expansion rather than the route. Bun takes fewer samples than Node, so run a case that lasts a second or more before trusting small percentages. Do not use `node --cpu-prof` with `tsx`: it reports every frame at line 1 and adds transpiler frames the built code does not have.
