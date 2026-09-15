# Search and route execution

Planning searches for an optimal sequence of movements. Execution carries them out tick by tick against live Minecraft physics.

The orchestration layer coordinates both systems to complete goals without freezing the bot or looping indefinitely.

## Incremental search plans routes in slices

The search engine in [search/search.ts](../../src/navigation/search/search.ts) implements an incremental A* graph search over planning states. Each planning state tracks the bot's foot coordinates, remaining scaffold count, and an overlay of predicted world changes.

Search executes in incremental slices through `advance()`. Slices yield to Node's event loop using `setImmediate`. This yielding ensures incoming network packets and physics ticks run without interruption during planning.

Timeouts measure compute duration rather than elapsed wall-clock time:

- [`DEFAULT_SEARCH_LIMITS`](../../src/navigation/navigate.ts): 500 ms primary timeout, 2,000 ms failure timeout, and 16-block segment length.
- [`DEFAULT_CONTINUATION_SEARCH_LIMITS`](../../src/navigation/navigate.ts): 4,000 ms primary timeout, 5,000 ms failure timeout, and 16-block segment length.

While it runs, a search keeps a shortlist of where it would walk if it had to stop now: `PartialRouteCandidates` in [search/search.ts](../../src/navigation/search/search.ts). Each candidate scores nodes as `heuristic + cost / coefficient` for one of seven coefficients from 1.5 to 10, so the strict end holds a node that got nearer the goal cheaply and the permissive end holds whatever is nearest the goal at almost any price.

A search starts under the longer failure budget. The first time any candidate is at least five blocks from the start (`MINIMUM_PARTIAL_ROUTE_BLOCKS`), the search has a fallback and the shorter primary timeout applies from then on. When a timeout expires, selection takes the goal if a route reached it, else the strictest candidate that travelled those five blocks, else the strictest that moved at all, else the closest node expanded, and the search cuts and returns a segment toward it.

## The planning overlay models prospective edits

The planning overlay in [search/planning-overlay.ts](../../src/navigation/search/planning-overlay.ts) models block modifications predicted along a candidate route.

Edits are stored in an immutable treap keyed by integer block coordinates. Every combination of world edits produces a deterministic content hash. This hash allows A* to detect identical planning states regardless of the order in which edits occurred.

When an edge assumes digging a block or placing a scaffold, the overlay records the change. Subsequent edges in the search branch evaluate against the modified overlay rather than the live world. The live [`WorldView`](../../src/navigation/world/world.ts) remains untouched.

## Execution drives movement on the physics tick

The route executor in [execution/route-executor.ts](../../src/navigation/execution/route-executor.ts) executes an immutable route plan step by step.

A step executes world interactions before movement. Breaks, placements, and block activations run first through the bot port in [bot.ts](../../src/navigation/bot.ts). Once interactions settle, the step hands physical movement to a controller.

Execution runs as a state machine on the physics tick:

- `starting_step`: Validates preconditions for the upcoming step.
- `awaiting_effect`: Awaits confirmation of a block break, placement, or door opening.
- `moving`: Drives control inputs on each physics tick until the bot lands in a valid arrival cell.
- `settled`: Concludes execution when all steps finish, or stops when interrupted.

### Momentum handoff between steps

Steps maintain momentum when safe. A walking or sprinting step followed by another compatible traverse hands over control in `continuous` mode. The bot maintains speed through corners without stopping.

When approaching an interaction, such as placing a scaffold or digging a block, the controller switches to `settled` mode. The bot brakes to a complete stop before swinging or placing.

### Movement controllers drive controls

Two specialised controllers in [execution/movement-controller.ts](../../src/navigation/execution/movement-controller.ts) generate tick control intents:

- `PlannedMovementController`: Controls walking, sprinting, falling drops, swimming, ladder and vine climbing, step-ups, and pillaring. It derives braking distance and arrival tolerance from observed velocity. Upward climbs keep the body centred from its current horizontal velocity, so sprint handoff or knockback cannot carry it out through a vine's open side. The Mineflayer adapter also supplies the missing vertical physics for weeping and twisting vine tips and plant segments in the pinned Prismarine Physics version.
- `GapController`: Controls two-block to four-block gap jumps. It executes a dedicated run-up, takeoff launch, airborne flight, and ground landing sequence.

## The ledger correlates world mutations

The expected-mutation ledger in [execution/mutations.ts](../../src/navigation/execution/mutations.ts) distinguishes the bot's own block changes from external world updates.

Before the actuator triggers a block interaction, the executor registers an expectation with target coordinates, expected prior state, expected final state, and an expiration deadline. When the world reports a block update, the ledger classifies the event:

- `expected`: The update matches the registered expectation. The pending interaction succeeds.
- `conflicting`: The target block changed, but its final state differs from the expectation.
- `invalidating`: An external change altered a block that the committed route depends upon. The executor invalidates the route and triggers a replan.
- `irrelevant`: The change occurred outside the route's dependencies.

Receipts keep settled expectations alive for a grace period. This grace period ensures delayed server acknowledgements are not misclassified as foreign invalidations.

## In-place breaking clears adjacent targets

The helper [`breakBlockInPlace`](../../src/navigation/execution/in-place-break.ts) in [execution/in-place-break.ts](../../src/navigation/execution/in-place-break.ts) mines an adjacent block without planning a path.

Mining processes call this helper when the bot already stands within reach of an ore. Standing in the target column satisfies an occupancy goal, so pathfinding to that spot would report arrival without digging. In-place breaking swings the actuator directly and verifies removal from the world.

## A held body breaks its ceiling before replanning

Minecraft keeps a player in the tallest of three poses that fits where they
stand: 1.8 blocks standing, 1.5 crouching, 0.6 crawling. Mineflayer models one
body of 1.8. A body that ends up under a ceiling between those heights, such as
a big dripleaf that has reset flat above a bot standing in the pool it dropped
it into, is crouched by the server and reported standing by the client, and
every position the client sends is refused and put back. No control moves it,
and no replanned step can.

[world/overhead-pin.ts](../../src/navigation/world/overhead-pin.ts) reads that
state from geometry alone: the standing column over the feet overlaps a
collision box that begins above the crawling pose. After any failed step the
run checks for it before judging the failure repeated. The normal excavation
policy checks protected cells, block permissions, tools, and liquid exposure;
a ceiling supporting falling blocks is refused. If admitted, the run breaks it in place, aiming
straight up as a downward dig aims straight down, clears its record of
repeated failures, and walks the same goal again. Otherwise it settles as
`no_progress` with reason `pinned_body`, naming the block, so the caller
stops asking for a route that cannot start. Either way a `pinned_body` event
records the cell and whether it was released.

Route interactions and ceiling release share
[world-effect.ts](../../src/navigation/execution/world-effect.ts), which waits
for physical completion and world confirmation. Cancellation, conflicting
changes, and deadlines stop the effect and await its cleanup before releasing
navigation. The deadline and the subsequent body-clearance wait remain
cancellable even when physics ticks stop.

## The orchestration loop drives the run lifecycle

The navigator in [orchestration/navigator.ts](../../src/navigation/orchestration/navigator.ts) admits one active run at a time. Simultaneous navigation requests receive a `{ kind: "busy" }` admission result.

The active run lifecycle in [orchestration/navigation-run.ts](../../src/navigation/orchestration/navigation-run.ts) follows an iterative loop:

```text
observe -> snapshot goal -> plan -> execute -> re-observe
```

1. **Observation**: Takes a fresh snapshot of bot position, inventory resources, and world revisions.
2. **Goal evaluation**: Snapshots the goal. If the goal is satisfied, the run settles or passes control to `onArrival`.
3. **Planning**: Obtains a route plan. If a partial segment is being walked, the run reuses the continuation search calculated ahead of time.
4. **Continuation search**: When walking a partial segment, the run starts a background continuation search for the next segment.
5. **Execution**: Walks the plan step by step while listening for world invalidations or caller abort signals.
6. **Cycle detection**: The run records search identities and movement failure fingerprints. If the same identity repeats without progress, the run terminates with a `no_progress` failure.
7. **Cleanup**: Settlement cleans up all active listeners, timers, actuator controls, and background continuation searches.

## Results and calculation failures report outcomes

Settled navigation returns a [`NavigationResult`](../../src/navigation/navigate.ts) union:

- `{ status: "completed", elapsedMs }`: The goal was satisfied.
- `{ status: "stopped", reason, elapsedMs }`: The run terminated early. The reason string specifies whether it was stopped by a deadline, caller signal, invalid goal, movement failure, or search limit.

If an inline search fails to find a route, it reports a [`NavigationCalculationFailure`](../../src/navigation/orchestration/process-events.ts):

- `no_path`: A* exhausted the accessible graph without reaching the goal. The event includes the closest search node reached.
- `search_limit`: Search exceeded its time or radius budget without finding a committable segment.

The caller's `onCalculationFailure` callback can inspect this failure, revise its target objective, and return `{ kind: "continue" }` to continue pathfinding under the same run.

## Stationary planning stall

An inline planning window is limited to 20 seconds without a route commitment
or meaningful observed displacement. New searches, start/world invalidations,
and goal revisions do not renew that window. Displacement is measured from an
anchor: at least one block horizontally or two vertically. Small jitter and
surface bobbing do not qualify. A dimension change starts a fresh window.

A route commitment clears the window. Route execution, including digging and
construction, and searches ahead of a moving route do not consume it. Existing
execution progress checks still apply to those phases.

Exhaustion returns `no_progress` with reason `planning_stalled`, including the
elapsed time and thresholds. The public navigation result is `stopped` with that
reason; it is not an invitation to the process to retry a calculation. Normal
navigation cleanup still settles owned effects and releases controls before the
caller receives the result, so total return time can include cleanup after the
20-second planning limit.
