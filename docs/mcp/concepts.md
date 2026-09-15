# Architecture and concepts

Mine AI MCP is designed around observable physical evidence, explicit
ownership, and strict separation between protocol, session, and execution.

## What standard governs Mine AI MCP?

Every source line must be straightforward for a maintainer to explain.
TypeScript types enforce valid states and make invalid dependencies difficult to
express. Every reported outcome reflects observed physical evidence rather than
assumed state.

The code avoids speculative abstractions, artificial retry loops, hidden
heuristics, and defensive fallbacks. The server observes and executes; the
calling AI model decides strategy. When a tool fails, the fault is addressed in
the narrowest layer that owns the broken fact.

## Why does a receipt say a count was not confirmed?

Mineflayer resolves a physical act on the first witness the server sends:
`consume` on the eating-finished entity status, `placeBlock` on the block
update at the target cell. The packet that redraws the inventory slot follows
a tick or so later. An action that counted its items on the next line reported
the count from before it acted, and every eat receipt read `1 → 1` as though
nothing had been eaten.

So every receipt that counts an item after acting waits for the count it
expects, through
[`settleInventoryCount`](../../src/world/inventory-count.ts). The wait is a few
ticks, because a receipt that cannot say what the inventory holds should say so
quickly rather than hold the model. `inventoryAfter` is the count observed when
that wait ended, and `confirmed` says which way it ended: `true` when the server
sent the expected count, `false` when the deadline passed first. A `false` means
the number is the last one seen and not an outcome — never that the act failed.
The witness each action already had, `consumed` or `placed`, still reports
whether the act itself was observed.

## How do the five layers divide responsibility?

The codebase enforces a five-layer structure with dependencies importing
strictly downward:

1. **Server layer** ([src/server/](../../src/server/)): Implements the MCP
   protocol adapter, JSON Schema export, HTTP transport, and process
   lifecycle.
2. **Session runtime layer** ([src/session/](../../src/session/)): Controls the
   foreground action runner, single-body locking, request continuation, and
   chunk listeners.
3. **Action layer** ([src/actions/](../../src/actions/)): Authors individual
   tools, input validation schemas, result formats, and execution routines.
4. **World layer** ([src/world/](../../src/world/) and
   [src/bot-data/](../../src/bot-data/)): Manages block placement geometry,
   chunk column analysis, and SQLite persistence.
5. **Physical layer**: Owns the live Mineflayer bot connection, physics engine,
   and plugin bindings.

## What is a host?

A host owns a public HTTP process and one child process containing the Mineflayer
connection. Implemented in
[src/server/host.ts](../../src/server/host.ts), the host serves the Streamable
HTTP MCP protocol at `/mcp` and health checks at `/health`.

The host owns process lifecycle, signal handling, and clean shutdown. Its public
process supervises the child's event-loop heartbeat, so an infinite JavaScript
loop in an action can be terminated and reported to its caller. This protection
is included in the package's `startHost` entrypoint by default.

## How does the host manage the Minecraft connection?

The connection connects the Mineflayer client to the target Minecraft server.
During startup in [src/server/runtime-host.ts](../../src/server/runtime-host.ts), the runtime loads
required plugins, listens for server login packets, and derives world identity
before advertising readiness.

If the connection drops or the bot is kicked, the runtime reports the lost
connection while leaving HTTP available for pending failures and inspection.
A new Minecraft connection requires an explicit host restart.

## How does the foreground session lock the bot's body?

The bot has one physical body. Concurrency is governed by a single foreground
lock in [src/session/action-runner.ts](../../src/session/action-runner.ts). Only
one model-directed task or autonomous reflex may control the bot at any instant.

If a new action request arrives while a task runs, the runner refuses the call
with `[ACTION_BUSY]`. Bad arguments fail validation before acquiring the lock,
preventing invalid calls from interfering with active work.

## What are the action kinds?

Every action declared in [src/actions/action.ts](../../src/actions/action.ts)
specifies its execution kind:

- `information`: Read-only queries such as `view_status` or
  `query_bot_data`. They never move the bot or modify blocks and advertise
  `readOnlyHint: true`.
- `task`: Foreground actions such as `craft_item` that acquire the physical lock.
- `resumable_task`: Foreground objectives such as `navigate` or `collect_block`
  whose retained executor can continue after an autonomous reflex.
- `control`: Out-of-band tools such as `cancel_foreground_action` that
  bypass the foreground lock to stop or observe active tasks.

MCP foreground submissions return an action ID immediately unless `wait_timeout_ms`
requests an initial bounded wait for a full result or pending progress. The bot runtime owns
the admitted execution independently of the submitting connection. A separate
`wait_for_action` returns pending progress or the complete typed output. Reading
that output automatically releases the result gate for the next foreground submission.
The logical slot remains reserved through suspension and cleanup, even when
the physical owner changes. See [async actions](async-actions.md).

## Why does the protocol require rationale and response format?

The protocol boundary in [src/server/mcp.ts](../../src/server/mcp.ts) extends
every tool schema with two protocol arguments:

- `rationale`: A required single-sentence explanation of why the action advances
  the goal. The server validates and logs this rationale before passing
  arguments to the action.
- `response_format`: An optional choice between `"markdown"` (the default) and
  `"json"`. Markdown returns concise readable summaries; JSON returns validated
  structured data without duplicate prose.

## How does bot data persist world observations?

Bot data is a local SQLite database owned by
[src/bot-data/sql-bot-data.ts](../../src/bot-data/sql-bot-data.ts). It provides
durable storage for bot status, carried inventory, container slot layouts,
discovered chunks, and action call logs.

The host runs synchronous, read-only queries against SQLite without blocking
connection state. Storage supports both persistent disk files and temporary
in-memory databases.

## What is the frontier?

The frontier tracks the boundary between explored and unexplored territory.
Managed by [src/runtime/frontier.ts](../../src/runtime/frontier.ts), it processes
loaded chunk columns and records biome samples, material palettes, and
surface-water fractions.

A chunk is flagged as a frontier chunk (`is_frontier = 1`) whenever at least one
of its four cardinal neighbours has not yet been committed to SQLite.

## How do events produce notification summaries?

Significant game occurrences are committed to the `events` table in SQLite
through [src/bot-data/event-log.ts](../../src/bot-data/event-log.ts) and
[src/runtime/player-events.ts](../../src/runtime/player-events.ts). Events include
incoming chat messages, player deaths, and hostile encounters.

Every MCP response evaluates unread events for the bot. If unread events exist,
the server includes a compact notification summary without advancing the bot's
read cursor.

## How does action cancellation work?

A running foreground task receives an `AbortSignal` managed by
[src/session/action-runner.ts](../../src/session/action-runner.ts). Calling
`cancel_foreground_action` requires the target `action_id` and a reason. It
prevents resumption and signals that objective to stop while necessary reflex
work can complete safe release. It does not cancel whichever physical owner
happens to be active. Wait for the final result before replacing the objective.
An already-settled target is an idempotent no-op; an unknown ID is refused.

## How does navigation move the bot?

The navigation runtime in [src/navigation/index.ts](../../src/navigation/index.ts)
is created once per bot session. It plans routes, navigates complex 3D terrain,
and excavates obstructing blocks to reach target positions. Complete details on
navigation goals and path execution live in
[../navigation/README.md](../navigation/README.md).

## How does combat claim the body?

The [hostile reflex](../../src/survival/reflexes/hostile.ts) supplies observations
and decisions to survival's shared driver. The session reserves body ownership,
releases the current execution, and admits the selected survival response.
Combat is one capability inside [survival](../survival/README.md), alongside
fire escape, breathing, footing recovery and hunger. Navigation owns routes and
local steering; actions request those capabilities instead of driving controls.
