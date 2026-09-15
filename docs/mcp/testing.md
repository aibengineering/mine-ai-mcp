# Testing and scenarios

Mine AI MCP proves itself at three speeds: colocated unit tests that run in
about a minute with no server, Mine Labs scenarios that arrange a real Minecraft
world and judge the outcome from outside the bot, and live playtests against a
retained world. This page names the principles behind that shape, describes
the unit layer, then describes the scenario and playtest layers.

## What principles shape the tests?

Three practices with names and precedents meet in this package's tests.

- **The test pyramid.** Many fast deterministic tests at the unit level, fewer
  at the integration level, fewest end to end, because cost and flakiness rise
  with each layer. Mike Cohn described it in _Succeeding with Agile_ (2009) and
  Martin Fowler restated it as the practical test pyramid. Here the unit suite
  runs in about a minute with no server, the scenarios need a Minecraft server
  and take minutes each, and the playtests need a live MCP host. A one-tick
  braking error belongs to the first layer; surviving a fortress belongs to the
  second.
- **A test for every bug.** When a defect is found, write the test that fails
  on it before fixing it, and keep the test. This is the oldest rule in Kent
  Beck's _Test-Driven Development: By Example_ (2002), and large projects follow
  it so literally that the test names are incident numbers: V8's regression
  directory is files called `regress-<issue>.js`, LLVM and Clang carry
  PR-numbered tests, SQLite's suite grew mostly from reported defects, and the
  Google SRE postmortem chapter lists a regression test among the expected
  outputs of a postmortem. This package keeps the same artefact with the bug
  number replaced by the observation: a comment such as "the fortress incident
  landed near the far lip at 0.259 blocks/tick" is the incident number.
- **Replay for control software.** Systems that act on physics cannot afford to
  reproduce every incident on hardware, so they record the inputs at the moment
  of failure and replay them against the decision logic. PX4 and ArduPilot ship
  unit tests beside software-in-the-loop simulation and flight-log replay;
  autonomous-driving stacks run log replay against the planner as their main
  regression tool. The movement tests under
  [src/navigation/](../../src/navigation/) are miniature log replays: a
  position and velocity recorded from a live run, fed to the controller, with
  the control intent for that tick asserted. That is why they hold odd decimals
  rather than round numbers, and why a hand-written case is worth less.

Each incident produces one test at the decision boundary, not the same proof
repeated at every layer above it. The known failure mode of incident tests is
pinning how the code happened to work rather than what the world required; the
defence is the comment that states the physical fact the test protects, so that
when the mechanism is redesigned the tests that described the world can be told
from the tests that described the old code.

## How is the unit layer arranged?

Unit tests are colocated `*.test.ts` files run by `bun run test` using Bun and the `node:test` API
under tsx; the same command typechecks the package and the scenario drivers
first. Three rules keep the suite small:

- **Tests purchase confidence, not line coverage.** Keep public contract tests,
  meaningful boundaries, and regressions backed by an observed failure. A test
  that asserts nothing its fixture could contradict is deleted, and tests that
  vary one input of one fixture are one table.
- **One double per interface, in one home.** The Mineflayer `Bot` double is
  `botFixture` in [src/test-support/bot.ts](../../src/test-support/bot.ts); the
  engine-side actuator double is `FakeNavigationBot` in
  [src/test-support/navigation.ts](../../src/test-support/navigation.ts); the
  bot-data stores are in [src/test-support/bot-data.ts](../../src/test-support/bot-data.ts).
  A test adds only the methods its subject calls as overrides. It never
  rebuilds the skeleton.
- **A test lives with the unit whose contract it exercises**, not with the file
  that was open when the bug was found. A test that builds a `MineflayerBot`
  belongs in the actuator's file, one that builds a `RouteExecutor` in the
  executor's, one that starts a navigator run in the run's. A thin layer over
  an engine is tested with a fake engine, so the layer's own logic is proven
  rather than the engine's proven twice.

## How do Mine Labs scenarios verify actions?

Scenarios run against Minecraft 1.21.4 servers managed by Mine Labs. Compatible resettable fixtures reuse their server; other fixtures receive a fresh world.
Mine Labs controls server lifecycle, world generation, game ticks, and external
verdicts. The scenario definitions and bot drivers are owned by this package under
[scenarios/](../../scenarios/).

A scenario asserts on physical facts observed by Mine Labs independently of the
bot: blocks remaining in the world, items present in inventory, or changes in
world time. A test fails if an action claims success but the physical change did
not occur.

### Assert outcomes; observe mechanisms

The fixture arranges an opportunity or difficulty, asks for the task and observes
the goal. Available cover is part of the arrangement. Using that cover is a
strategy. Collecting the requested rods without dying is the acquisition goal.
Only the goal and explicitly declared constraints belong in its verdict.

Requiring a particular tactic is **implementation-coupled testing**: the
acceptance criteria accidentally specify how the implementation must work.
It creates false failures when a different strategy succeeds and false passes
when the expected sequence occurs without achieving the goal. Weapon selection,
shield use, cover movement, response order and body ownership belong in traces.
The scenario driver must not choose policy or retry failed continuations to help
the implementation pass.

An observable fact can still prescribe a tactic. Killing an aggressor is a
valid defeat goal, but requiring that kill during a collection or travel task
rejects successful avoidance. Likewise, a hit, shield block, or air loss is not
required merely to prove that an arranged hazard mattered. Verify the hostile
or environmental stimulus was arranged, then judge the requested outcome.

Impossible-world fixtures may explicitly test truthful failure: a sealed,
unbreakable target must not yield a fabricated success. They should not require
a particular internal stop reason, retry count, or route sequence.

Component contracts still matter. A request to place a wall must produce a wall;
an explicit prohibition on digging must be honoured; cancellation and body
release must work. Those assertions qualify those contracts. They cannot be
silently added to a general survival or acquisition goal. Defeating a finite mob
is also a distinct goal from acquiring its random loot.

## What scenario groups exist in the repository?

Scenarios are organised by world shape in [scenarios/](../../scenarios/):

### Flat worlds (`scenarios/flat/`)

- `collect/`: Verifies mining target blocks, item drop recovery, falling sand or
  gravel columns, and inventory fullness limits.
- `combat/`: Tests the combat reflex across hostile mob types (zombies,
  skeletons, creepers, spiders, phantoms, and endermen), varied equipment, and
  preemption of foreground tasks.
- `evidence/`: Executes every published standard action against a test world and
  dumps real request schemas and responses.
- `explore/`: Verifies directional frontier expansion and chunk discovery.
- `hunt/`: Tests native defeat goals, drop collection, and inventory
  gains.
- `pathfinder/`: Validates pathfinding across terrain obstacles, scaffolding,
  descents, and underwater hazards.
- `sleep/`: Tests bed placement, navigating to beds, skipping the night, and
  detecting nearby hostiles.
- `storage/`: Verifies container inspections, deposits, withdrawals, stack
  recompaction, and container sorting.
- `water/`: Tests background buoyancy reflexes in deep water while idle or
  between pathfinder routes.

### Default terrain worlds (`scenarios/default/`)

- `progression/`: Runs the `primitive-progression-to-diamond` qualification
  scenario, executing a complete dependency sequence from bare hands to diamond
  tools on an authored survival map.
- `terrain/`: Validates long-distance traversal across natural generated terrain
  and unloaded chunk boundaries.

## What package scripts run scenarios?

Two scripts forward paths and options directly to Mine Labs. `scenarios` defaults
to two parallel workers; an appended `--jobs` overrides it. `scenarios:client`
uses the managed client's own concurrency setting.

`scenarios` repeats supplied files or folders until stopped. Use `--repeat 1`
for one pass. `scenarios:client` opens the managed client and scenario picker;
its controls select scenarios and repetition. With no paths, Mine Labs opens
the picker rooted at `scenarios`, including when invoked through `scenarios`.

Run these commands from the package root:

```sh
# Soak the regular suites with two workers.
npm run scenarios -- scenarios/flat scenarios/default

# Run one fixture once.
npm run scenarios -- scenarios/flat/collect/oak-tree.yaml --repeat 1

# Run a folder once with two workers.
npm run scenarios -- scenarios/flat/combat --repeat 1 --jobs 2

# Open the client picker, optionally restricted to a folder.
npm run scenarios:client
npm run scenarios:client -- scenarios/flat/collect
```

npm forwards arguments after `--` to the script. Bun forwards them directly:
`bun run scenarios scenarios/flat/collect --repeat 1`.

The scripts use Mine Labs' local output defaults: `.mine-labs` for headless
runs and `.mine-labs/open` for the client. Pass `--out <directory>` to change
the location. Stop a soak with Ctrl+C.

The separate shared-world verification mode remains available directly:
`bunx --bun mine-labs verify scenarios/verification --jobs 2`.

## How do live playtests differ from scenarios?

Scenarios run headless, isolated trials against disposable servers. Playtests run
against a long-lived local Minecraft instance and execute interactive operator
tasks across persistent worlds.

Playtests inspect multi-step interactions against the running host through its MCP tools.
