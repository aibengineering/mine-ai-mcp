# Mine AI MCP

Mine AI MCP is a batteries-included Model Context Protocol (MCP) runtime for letting AI play Minecraft. It
provides external AI agents with reliable, observable tools to inspect,
navigate, and interact with a live Minecraft world.

Every tool operates on a trust promise. A successful result means the requested
physical or inventory outcome was observed directly in the world. A failure
reports what was observed without inventing a cause.

Foreground tools accept optional `wait_timeout_ms` to return the full typed result
or pending progress in the initial call. Omit it for an immediate action ID; use
`wait_for_action` to retrieve pending work before the next submission. Returning the full
result automatically releases the result gate. See [asynchronous action usage](async-actions.md) and
[qualification evidence](async-actions-qualification.md).

## How to start the host

The host serves Streamable HTTP endpoints on loopback and owns one child process
containing the Mineflayer connection. The entry point is
[src/server/host.ts](../../src/server/host.ts). It parses arguments with
[src/server/config.ts](../../src/server/config.ts) and publishes `/mcp` and
`/health`. Besides vitals and the runner's status, `/health` carries
`recentCalls`: the last eight protocol calls, newest first, each with its
arguments, rationale, status and duration. `foreground.active` retains the
logical objective and progress when `recentCalls[0]` becomes a wait or status
read. `foreground.awaitingResult` identifies an unread result separately from
the physical owner. Observers should use `foreground` to display ongoing work.
`/health` also carries `inventory`, every slot the connection owner can see in
player-inventory coordinates, because a Minecraft client is sent only another
player's six equipment slots.

Launch the host with Bun. It runs the TypeScript source directly, so there is no
build step:

```bash
bun src/server/host.ts --minecraft-host 127.0.0.1 --minecraft-port 25566 --username MineAI --listen-port 25575
```

The host accepts configuration flags for connection, storage, and debugging:

| Flag                            | Default               | Meaning                                                                   |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `--instance-id <name>`          | `minecraft`              | Name the host prints in its log lines.                                    |
| `--minecraft-host <host>`       | `127.0.0.1`           | Minecraft server address.                                                 |
| `--minecraft-port <port>`       | `25566`               | Minecraft server port.                                                    |
| `--username <name>`             | `MineAI`           | Bot player name.                                                          |
| `--auth <mode>`                 | `offline`             | Mineflayer authentication mode: `offline` or `microsoft`.                 |
| `--version <version>`           | `1.21.4`              | Target Minecraft version.                                                 |
| `--connect-timeout-ms <ms>`     | `45000`               | How long to wait for the bot to spawn before the host gives up.           |
| `--listen-host <host>`          | `127.0.0.1`           | Local bind address for HTTP.                                              |
| `--listen-port <port>`          | `25575`               | Local HTTP port for `/mcp` and `/health`.                                 |
| `--data-root <path>`            | `~/.mine-ai/bot-data` | Directory holding persistent SQLite databases.                            |
| `--bot-data-persistence <mode>` | `persistent`          | Storage mode: `persistent` SQLite file or `temporary` in-memory database. |
| `--bot-data-scope <scope>`      | `bot`                 | Database isolation: `bot` for one player UUID or `shared` for the world.  |
| `--debug-execute-javascript`    | `false`               | Publishes unrestricted debug tools when set.                              |

The host runs until stopped with `SIGINT` or `SIGTERM`. It disconnects cleanly
and releases all database locks on exit.

Protection against an unresponsive runtime is part of this package's host;
the CLI and library entrypoint `startHost` use the same startup path.
The public listener opens first, starts the bot runtime, and supervises its
timer heartbeat. `/health` returns 503 during startup and after runtime failure.

Combat and navigation loops use an 8 ms uninterrupted execution slice to yield
to packet handling, physics, and cancellation. This does not limit encounter
duration. Execution transitions are recorded as they happen, independently of
physics samples; the first forced yield in an execution scope saves an
`execution_slice_exhausted` incident in the runtime's normal incident store.

If code bypasses checkpoints and its event loop stops responding for five
seconds, the supervising host terminates its owned runtime and returns a
JSON-RPC `-32603` error with `data.code: RUNTIME_UNRESPONSIVE` and an incident
receipt. An unexpected runtime exit returns `RUNTIME_EXITED`. Pending and later
MCP calls receive this error; `/health` reports `runtime.state: failed` and the
same receipt. The host remains available until explicitly stopped or restarted.
It never retries the interrupted action or claims its physical outcome.

Host incidents live under `<data-root>/host-incidents/<encoded-instance-id>/`,
or the OS temporary `mine-ai` directory for temporary storage. They contain the
last execution transitions, heartbeat counters, runtime memory samples, and
pending HTTP paths and MCP tool names. Active execution scopes are retained for
their whole lifetime, even when their entry events leave the 20-second ring or
their HTTP client disconnects. Failures include these last-observed scopes in
the MCP error and incident, with durable action request IDs, navigation search
counts or movement phases, frontier chunk work, and the observation's age.
These are breadcrumbs, not a captured stack or proof of the blocking cause.
The incident also records delay in the supervisor's own watchdog timer, so a
delayed supervisor is visible alongside a missing runtime heartbeat.

`GET /diagnostics/runtime` reads the supervisor's latest activity and heartbeat
without depending on the bot's event loop. It remains available after failure.
`/health` also reports `minecraft.frontier.pendingChunks` for queued chunk scans.
Host incident retention uses the same five-day / 64 MiB defaults as runtime
incidents. The receipt reports a write failure if the artifact cannot be saved.

After storage initialization, a conflicting SQLite writer produces an immediate
database error. Runtime writes do not wait synchronously for a lock and block
physics or heartbeats; startup retains its existing transient-lock allowance.

## How to make a first tool call

Start the host as shown above, then register its HTTP endpoint with your MCP
client using the [client setup instructions](../../README.md#connect-an-mcp-client).
Every tool call requires a `rationale` explaining why it advances the goal. For
example, call `view_status` with:

```json
{"rationale":"Inspect vitals, position, and inventory before acting."}
```

The call returns the bot's health, hunger, world clock, exact coordinates,
held item, carried inventory stacks, and nearby entities.

## Combat progress and interrupted requests

Every mob combat phase declares the observation it is waiting for. The current
phase, expected observation, ticks spent in each phase, completed effects, and
engagement progress are available at `/health` under `minecraft.combat.execution`.

Every foreground action also retains combat resource totals across automatic
combat takeover, resumption, and settlement. `progress.combatResources` reports
confirmed arrows fired and recovered, durability used by slot and item, native
shield blocks, completed food consumption, confirmed combat scaffold placement,
and observed weapon changes. A timed `wait_for_action` returns only the changes
within that caller's interval under `duringWait.combatResources`; concurrent
waiters keep independent baselines. Arrow inventory loss without a correlated
bow release is not a fired arrow, and shield durability loss without the native
block status is not a shield block.

`progress.reflexActivity` summarizes the survival states occupied while the
action owned reporting: each reflex response entered, each candidate response a
reflex withheld together with its exclusion, and each combat controller phase,
with an entry count and the time spent in that state. Withheld responses whose
exclusion is `prohibited` name the survival policy field responsible; other
exclusions (missing equipment, an answered scope, an infeasible premise) are not
policy choices. A state already occupied when the action was admitted accrues
time but no entry. `duringWait.reflexActivity` reports each waiter-local
interval.

`arrowsFired` currently requires the release's normal arrow inventory
confirmation. An Infinity bow consumes no arrow, so its shots are not counted;
the runtime does not guess ownership from an unowned nearby arrow entity.
Attack attempts and server-confirmed target hits are separate counts. Completing
an effect, changing phase, refreshing a shield, revisiting a route cell, or
retargeting does not by itself renew the engagement's progress clock. Verified
navigation steps to new cells, a newly usable attack position or protection, and
confirmed target damage do. Incidental defensive hits, completed incoming volleys,
and recovered health are recorded separately from the requested target's progress.

A healthy engagement without objective progress produces a notice after fifteen
seconds; unanswered health loss produces one after five seconds. These retain the
existing combat diagnostic windows (five seconds covers a blaze attack cooldown).
They are visibility thresholds, not deadlines that abandon defence. When a reflex
has interrupted a resumable request, a waiting notice remains diagnostic: the
request stays pending until the physical response settles or the user cancels or
replaces it. A successful, sufficiently healthy settlement can resume the request.

An intentional enderman hunt checks defensive building material before approaching
or aiming at its selected target, using the same read-only roof planner that
combat rechecks before construction. It returns `COMBAT_BUILD_MATERIALS_MISSING` with a
partial result if progress was observed, or a failed result otherwise. Existing
usable roofs still work without carried material, and an already-active hostile
reflex keeps defending. A target-specific route or geometry failure remains
distinct from an inventory shortage.

The deliberate enderman sequence is: price a complete roof, reach its building
position, provoke the target, observe native hostility, then build that roof.
Only the pre-construction gaze must be clear; the finished eave may hide the
target's eyes. `roof_provoked` and `roof_prepared` decisions record the order in
incident traces. Roof refusals report the searched position and target, supported
candidate count, and terrain, material, occupancy, and gaze rejection counts.

Blaze hunts also check defence before approach. A carried shield suffices when
one facing covers the selected blaze and other exposed shooters. Otherwise,
the same cover planner used by combat must find existing protection or an
affordable construction plan. An unbuildable position returns
`COMBAT_COVER_UNAVAILABLE`; an insufficient block supply reports its actual cost.

Hunt results count engagement attempts separately from actual `retargets` and
retain `targetChanges` with the old/new target IDs, the new target's observed
position, and the reason for changing. Repeating an attempt against the same
target does not increment retargets. Final combat engagement events also retain
the observed reason for refusing or ending the fight.

The existing 20-second / 8-MiB incident recorder keeps detailed execution and
physics history and saves a `combat_waiting` capture on the notice. Durable
`combat_engagement` events retain starts, waits, damaging stalls, resumed progress,
and final outcomes, with one engagement ID and the originating request ID across
the entire fight. Read them with `read_recent_events`, or query without
advancing the unread cursor:

```sql
SELECT event_id, observed_at, payload_json
FROM events
WHERE event_type = 'combat_engagement'
ORDER BY event_id DESC
LIMIT 20
```

## Documentation pages

Read these pages for each part of the system:

- [Concepts](concepts.md): Architecture layers, foreground locking, action kinds, and lifecycle.
- [Tools](tools.md): Every published tool grouped by job, with arguments and verification evidence.
- [Bot data](bot-data.md): The SQLite schema, query rules, data dictionary, and storage modes.
- [Events and responses](events-and-responses.md): Response representations, notification summaries, and the event stream.
- [Testing](testing.md): Mine Labs scenario suites, playtests, and execution scripts.
- [Limitations](limitations.md): Current capability and dependency boundaries.

## Further reading

- [Async actions design](async-actions-design.md): Proposed foreground submission, waiting, progress, and result retrieval contract.
- [Bot data query guide](query-guide.md): Read-only SQL surface, safety constraints, and query design.
- [Navigation](../navigation/README.md): Navigation APIs, movement, search, execution, and telemetry.
- [Survival](../survival/README.md): Combat, environmental responses, and request continuation.
