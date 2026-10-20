# Testing and scenarios

Mine AI MCP proves itself at three speeds: colocated unit tests that run in
under fifteen seconds with no server, Mine Labs scenarios that arrange a real
Minecraft world and judge the outcome from outside the bot, and live playtests
against a retained world. This page names the principles behind that shape, describes
the unit layer, then describes the scenario and playtest layers.

## What principles shape the tests?

Three practices with names and precedents meet in this package's tests.

- **The test pyramid.** Many fast deterministic tests at the unit level, fewer
  at the integration level, fewest end to end, because cost and flakiness rise
  with each layer. Mike Cohn described it in _Succeeding with Agile_ (2009) and
  Martin Fowler restated it as the practical test pyramid. Here the unit suite
  runs in under fifteen seconds with no server, the scenarios need a Minecraft
  server and take minutes each, and the playtests need a live MCP host. A one-tick
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

Unit tests are colocated `*.test.ts` files run by `bun run test` using Bun and the `node:test` API;
the same command typechecks the package and the test and scenario code first, with
`bun check` (Bun 1.4.3 or newer; the build still emits with `tsc`). The tests
run with `--parallel`, so each file gets its own worker and fresh globals. The
test command names `./src` and `./tests` as explicit directories:
bare names are Bun path filters and can also select ignored private experiments.
Four rules keep the suite small and quick:

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
- **Waiting and output go through options and helpers, not sleeps and prints.**
  A production wait or clock is an option whose default is the production
  value, such as eat-food's `settleMs`, the actions' `inventorySettleMs`, or
  the mining request's `now`, so a test passes a window of a few milliseconds
  and lets it lapse for real, or a clock it advances, instead of sleeping
  through the deadline or mocking the global timers;
  `deferred` and `nextTurn` in [src/test-support/async.ts](../../src/test-support/async.ts)
  replace hand-rolled promises. Operator notices likewise go to a sink the
  caller supplies (`OperatorNotices` for the host and supervisor, `log` on
  `SqlBotData`, `report` on `observeBotStatus`), defaulting to the process
  streams, so a test records them and asserts on them rather than patching
  stdout. A test that must wait on a real timer says why in a comment.
- **A test lives with the unit whose contract it exercises**, not with the file
  that was open when the bug was found. A test that builds a `MineflayerBot`
  belongs in the actuator's file, one that builds a `RouteExecutor` in the
  executor's, one that starts a navigator run in the run's. A thin layer over
  an engine is tested with a fake engine, so the layer's own logic is proven
  rather than the engine's proven twice.

## How do Mine Labs scenarios verify actions?

Scenarios run against Minecraft 1.21.4 servers managed by Mine Labs. Compatible resettable fixtures reuse their server; other fixtures receive a fresh world.
Mine Labs controls server lifecycle, world generation, game ticks, and external
verdicts. The scenario definitions and bot drivers are owned by this package, in
the two catalogues described below.

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

[tests/minecraft/scenarios/](../../tests/minecraft/scenarios/) is the suite the
package scripts run. Its fixtures are grouped by behavior (`barter`, `bucket`,
`build`, `collect`, `combat`, `craft`, `drop`, `explore`, `hunt`, `pathfinder`,
`portal`, `progression`, `sleep`, `storage` and `survival`), and flat,
generated, Nether and End worlds appear side by side within a group. Each
fixture declares its purpose and tags, and every one runs through the runtime
host in `tests/minecraft/`. Most consolidate several related behaviors into one
world, often with one bot per walled pen, so a regression in any of them fails
the fixture. Its [README](../../tests/minecraft/README.md) describes the
templates, drivers, pens, tags and evidence options.

[tests/minecraft/known-failing/](../../tests/minecraft/known-failing/) holds
faithful fixtures for behavior that fails today, outside both tiers. A fixture
moves into `scenarios/` when its behavior is fixed.

The legacy catalogue that used to live in `scenarios/` was retired in October
2026; [the migration ledger](../plans/2026-10-scenario-migration.md) records
where each of its fixtures went.

## What package scripts run scenarios?

Scenarios need Bun and **Java 21**. Mine Labs starts each Minecraft server, and
the spectator build runs Gradle, with `$JAVA_HOME/bin/java` when `JAVA_HOME` is
set and `java` on `PATH` otherwise. If the default Java is older, prefix the
command, for example `JAVA_HOME=/path/to/jdk-21 bun run scenarios:once`.

The suite has two tiers, split by the scenario tag `slow` (End fights, long
Nether hunts and anything over about five minutes).
`scenarios:once` runs the fast tier of `tests/minecraft/scenarios` once,
skipping `slow` fixtures, which is the check to make after changing a
fixture, template, driver or the host. `scenarios` repeats that fast tier until
stopped; appended options such as `--jobs` and `--repeat` override its defaults.
Every script runs one trial at a time at below-normal CPU priority, so a run
does not take over a machine someone is using; append `--jobs N` or
`--normal-priority` to opt out.
`scenarios:full` runs every fixture in `tests/minecraft/scenarios` once, `slow`
ones included.
`scenarios:known-failing` runs `tests/minecraft/known-failing` once: faithful
fixtures for behaviour that fails today, which neither tier discovers.
`scenarios:spectator` builds the highlighter and opens the whole suite in the
managed Java viewer. Its controls select scenarios and repetition. The YAML
`client` command still runs the bot participant in either mode.

Run these commands from the package root:

```sh
# Run the fast tier once.
bun run scenarios:once

# Soak the fast tier.
bun run scenarios

# Run every fixture once, slow ones included.
bun run scenarios:full

# Run one fixture once.
bunx --bun mine-labs run tests/minecraft/scenarios/collect/mixed-trees.yaml --repeat 1

# Run a folder once with two parallel workers.
bunx --bun mine-labs run tests/minecraft/scenarios/combat --repeat 1 --jobs 2

# Build the viewer mod and open the whole suite.
bun run scenarios:spectator

# After building, open only the collection folder.
bunx --bun mine-labs run tests/minecraft/scenarios/collect --spectator

# Drive and watch the suite from your own Minecraft, such as a phone, over Tailscale.
bun run scenarios:tailscale
```

`scenarios:tailscale` uses Mine Labs' Tailscale remote mode. It opens no client
on this machine. It serves the dashboard, the scenario worlds and the highlighter
feeds on this machine's tailnet address only, with no login, so your tailnet
controls access. Open the printed address in the device's browser to download
the Mine Labs and highlighter mods for a NeoForge 1.21.4 instance, then enter the
same address on the in-game **Mine Labs** screen. Play on your normal account.

Use the Mine Labs command directly to replace the script's scenario directory.

The scripts use Mine Labs' local output defaults: `.mine-labs` for headless
runs and `.mine-labs/open` for the client. Pass `--out <directory>` to change
the location. Stop a soak with Ctrl+C.

A fixture can list surveyed spawn locations under `verification.locations`;
`mine-labs run` expands them into one isolated trial per location, as
`progression/progression-to-diamond` and `collect/cast-obsidian` do.

## How do live playtests differ from scenarios?

Scenarios run headless, isolated trials against disposable servers. Playtests run
against a long-lived local Minecraft instance and execute interactive operator
tasks across persistent worlds.

Playtests inspect multi-step interactions against the running host through its MCP tools.
