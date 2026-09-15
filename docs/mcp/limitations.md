# System limitations

Mine AI MCP deliberately limits the scope of its tools. The server focuses on
atomic, observable operations and leaves high-level strategy to calling agents.

## What capabilities are outside Mine AI MCP?

The server does not include autonomous reasoning, ambient world roaming, or
meta-game planning. When an action finishes, the bot remains stationary until the
caller issues the next command.

Specific capability boundaries are detailed below.

## Why are player-built structures unprotected during movement?

When digging through obstacles or placing scaffolding, `navigate` and
`collect_block` treat all non-fluid blocks identically according to break
cost. They do not distinguish between natural terrain and player-crafted walls
or decorative architecture.

## Why does the server avoid strategic decision making?

The server does not make progression decisions, select research targets, or
queue follow-up tasks. An action executes the requested command, reports the
observed outcome, and stops.

All game strategy, inventory management choices, and task sequencing belong to
the external AI model.

## How is loaded world discovery constrained?

Finding blocks or entities beyond the bot's direct line of sight requires moving
the bot or querying previously committed chunks in SQLite. The server does not
offer an unrestricted search across loaded memory.

## What combat scenarios are out of scope?

The combat reflex in [src/survival/index.ts](../../src/survival/index.ts) activates
only on hostile contact: a hostile within eight blocks, or one that has already
damaged the bot. It fights one target at a time with the best carried bow, sword,
axe, tool, or bare hands, or evades to a safe distance. The
[combat docs](../survival/README.md) describe the ladder and the policy.

See the [survival guide](../survival/README.md) for supported defensive responses
and their current limits.

## Why are furnaces and ender chests excluded from container management?

The `use_container` tool operates on static storage units like chests and
barrels. Furnaces possess distinct input, fuel, and output slots and are
controlled exclusively through `smelt_item`. Ender chests belong to
individual player accounts rather than world coordinates and are excluded from
location-based container storage.

## What dependencies does the package need?

The action runtime, HTTP transport, and build configuration live in this package.
Runtime dependencies are installed through package.json, including the block
highlighter and pinned upstream forks. Mine Labs is a development dependency for
scenario execution. See the [quick start](../../README.md#quick-start-use-an-existing-minecraft-server)
for runtime prerequisites and the current publication status.
