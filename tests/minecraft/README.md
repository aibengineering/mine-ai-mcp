# Minecraft scenarios

Each fixture owns three things: the world and player arrangement, the action
request, and the expected outcome.

Verify scenario drivers by running their Minecraft scenarios, rather than
maintaining unit tests that repeat their assertions. Unit coverage belongs to
shared harness behavior: readiness, cancellation, cleanup, and the rule that an
unexpected action outcome cannot become a successful completion.

Starting worn or held items belong under `players[].equipment`, for example
`equipment: { head: golden_helmet }`. Mine Labs equips these before the trial;
drivers should only call `equip` when equipping is part of the behavior under test.

Everything for this suite lives here: shared host files at the top level,
replaceable test logic in `drivers/`, YAML defaults in `templates/`, and runnable
cases in `scenarios/`. Point Mine Labs at `scenarios/`, not this whole directory:
it recursively discovers every YAML file, including templates.

Group scenarios by behavior: `collect`, `craft`, `build`, `bucket`, `barter`,
`drop`, `explore`, `hunt`, `combat`, and `pathfinder`. World type and multi-location
verification belong in the fixture's YAML, so flat and natural-world cases
appear together when reviewing a capability.

## One action, specified in YAML

Each scenario also declares its purpose in `description` and its type in `tags`:

- `acceptance`: a capability or behavior we expect to work.
- `regression`: a known failure we want to keep fixed; describe that failure too.
- `reliability`: repeated execution exposes marginal movement or control behavior.

Keep scenarios in their behavior folders. In Mine Labs, press **F9** to inspect
the current or most recently run scenario, including its purpose and live goals.
F9 again or Escape returns to where you were; trials continue while reading.
The shortcut is remappable in Minecraft Controls → Mine Labs. F10 opens the
dashboard, where every tag has a text badge with a consistent automatic color,
and tags can filter across folders. The meanings above belong to this suite;
Mine Labs accepts arbitrary labels and assigns no meaning to their colors.
Filters affect the list; **Run folder** and **Run all** still run their whole scope.

```yaml
tags: [regression]
description: >-
  Reproduce a known failure, explain its trigger, and state the expected outcome.
```

For example, a single coal collection asks:

```yaml
params:
  action: collect_block
  input:
    block_name: coal_ore
    count: 5
    scaffold: false
```

`drivers/single-action.ts` reads that envelope, calls the named action
once, and checks its expected result (success by default). Any action registered by the runtime
can be selected; there is no action-specific driver or switch statement.
Use `input: {}` for an action with no arguments. Action schemas validate the
input; the driver validates the request envelope and optional expectation.

For an expected partial result or refusal, declare it separately from the input:

```yaml
params:
  action: collect_block
  input: { block_name: stone, count: 4, scaffold: false }
  expect:
    status: partial
    errorContains: "[INVENTORY_FULL]"
```

`expect.status` accepts `succeeded`, `partial`, or `failed`. Optional
`errorContains` matches literal text, not a regular expression. Both conditions
must match; mismatches report the expectation alongside the actual action
summary. Runtime failures and cancellations always fail the trial. These are
our driver's parameters, not Mine Labs goal types.

`expect.interruptionContains` can require a recorded interruption reason. The
combat collection case checks `[HOSTILE_CONTACT]` so merely finishing before the
zombie arrives cannot pass. This proves interruption of the collection action;
it does not assert which mining animation frame was interrupted.

For a short sequence that shares one fixture, select `drivers/action-sequence.ts`:

```yaml
client:
  command: bun
  cwd: ../..
  args: [client-host.ts, drivers/action-sequence.ts]
params:
  actions:
    - { action: collect_block, input: { block_name: coal_ore, count: 3, scaffold: false } }
    - { action: collect_block, input: { block_name: iron_ore, count: 3, scaffold: false } }
```

Every step must succeed, and the sequence stops on the first failure. Final
inventory and world assertions stay in Mine Labs goals. Use a custom driver only
when the scenario needs logic beyond an ordered list of successful calls.

## Combined behavior scenarios

Related regressions share a fixture while retaining their own stage or physical
assertion:

| Scenario | Coverage folded into it |
| --- | --- |
| [workshop](scenarios/craft/workshop.yaml) | Nine-log crafting, door recipe output, smelt-batch-lag, temporary furnace smelting, and floating furnace recovery. |
| [exact-collection-preservation](scenarios/collect/exact-collection-preservation.yaml) | Exact coal and birch door targets, explicit chest/table collection, protected storage and return navigation. |
| [movement-course](scenarios/pathfinder/movement-course.yaml) | The original constrained stair descent, ramps, soul sand, vines, ladders and unsupported diagonal treads. |
| [gauntlet-lava-parkour](scenarios/pathfinder/gauntlet-lava-parkour.yaml) | Maximum gap crossings plus the obstacle course's steps, drops, magma detour and door. Repeat it for movement reliability. |
| [cave-excavation-course](scenarios/pathfinder/cave-excavation-course.yaml) | Carpet maze, dripstone stairs and the unavoidable sand curtain. |

`navigate-route.ts` checks each named arrival with `view_status`, after ten
physics ticks let the final landing settle. It requires full health at every
checkpoint. Digging defaults to false; only the cave excavation course enables
it. Scaffolding is always disabled. Mine Labs also checks the final position,
health, deaths and protected or cleared blocks independently.

The workshop runs at 16 TPS and checks inventory between stages, before later
calls can consume or replace evidence. Its temporary batch cooks nine items
across two coal, beyond the old premature recovery deadline. Both furnace modes
must report the quantities actually carried, and the temporary furnace must be
recovered. Cooking into an existing ingot stack also checks output accounting.

Keep assertions that prevent a false pass: the arrow hunt checks the sole
unenchanted bow's unchanged durability, the netherrack bank measures at most 64
blocks removed for 32 collected, and coal-under-sand disables regeneration so
healing cannot hide suffocation damage. These checks use ordinary observation
actions through the existing host; no driver controls the bot or changes policy.

## Independent world goals

Mine Labs checks the outcome independently:

```yaml
goal:
  kind: all
  timeout: 45
  goals:
    - { kind: hasItem, item: coal, count: 5 }
    - { kind: completion }
```

The first goal reads the player's inventory on the Minecraft server. The
second requires the driver to report success. Neither the action's claim nor
the inventory alone can pass this test. Omitting `who` selects the first player.
The timeout is the trial's budget, not an action timeout.

## Shared setup

`templates/flat-single-action.yaml` owns the shared flat world, reset region,
spectator rule, and client command. It lives beside `scenarios/` so Mine Labs
will not discover it as a runnable test.

Fixtures using it live in `scenarios/<category>/`. The default spectator rule
expects one player named `Actor`; fixtures with other player names override
`tick` to preserve those participants. Each fixture declares its own position,
equipment and geometry.
The client working directory resolves from each fixture to this suite's root;
the host and driver arguments are relative to that root.
The reset region covers these collect arenas; a larger arena must override it.
Mine Labs replaces whole top-level fields when merging templates, so a fixture
overriding `world` or `client` must supply that entire field.

The host connects the bot, observes the arranged player state, and waits for
landing and vitals before creating the runtime and reporting prepared.
It observes a health packet rather than using food level as a readiness check.
Physics is paused only while setup waits for the declared player state and
starting terrain. It resumes before landing, with no spawn handler left to
pause physics during execution.
Starting grounded is the default. Add an exception only when a real fixture
needs to start off the ground; there is no configuration option for it now.
The action starts only after Mine Labs sends `start`.

## Runtime boundary and evidence

The host builds `createMinecraftRuntime` once. Drivers receive only `scenario`
and `call(action, input)`. The bot, runtime, cancellation and action recording are
owned by the host.
`call` records the request, runs the registered action, records its full output
and summary, and returns them. It does not decide whether a test passed.
The host closes the runtime before reporting completion so artifacts are flushed.

The implementation has three responsibility boundaries:

- `client-host.ts`: load the driver, prepare the bot, run the trial, report completion.
  Action lookup, execution, recording and summaries live together in this file.
  The runtime is scoped with `await using`, so every exit disposes it before reporting.
- `scenario-bot.ts`: connect, observe arrangement, wait for landing, and disconnect.
  After completion the bot stays connected for Mine Labs' final world observations;
  Mine Labs' stop signal closes it. A setup or host failure also closes it.
- `drivers/single-action.ts`: read the YAML request, call the action, and check its expected result.

Player-arrangement observation uses the shared helper at
`../../scenarios/src/player-preparation.ts`.

`runWithRuntime` creates the runtime and waits for the start signal before timing
the driver's run. Preparation
errors reach Mine Labs' client error handler; execution errors become failed
completions with elapsed time. Cancellation unwinds cleanup without reporting a
second outcome for a trial Mine Labs has already stopped.

This suite tests actions directly through `runtime.run()`, with the runtime's
navigation, reflexes, survival and incident recording. It does not exercise MCP
transport, async submission IDs, or the submit/wait/result-retrieval protocol.
Its call-log entries contain the action input and output, not MCP replies.

When the template declares the highlighter, `scenario-highlighter.ts` exposes
its loopback feed at the game server port plus the declared offset. It passes
the highlighter into the runtime for action block highlights and subscribes to
`runtime.navigation.onEvent` for committed routes. It adds no movement behavior;
the subscription and listener close with the runtime. Multi-player fixtures show
the first declared participant. Without a polling viewer, action block highlights
are inactive; route events only replace the latest path. Built-in incident
recording and progress tracking remain unchanged.

Runtime evidence is temporary by default: bot SQLite stays in memory, and incident
files are removed after the runtime closes, even if the driver fails or is cancelled.
Mine Labs still retains its normal results, scenario snapshots and client/server logs.
Existing artifacts from earlier runs are not removed by this setting.

To retain the SQLite database and incident files for an investigation, set the
host's `MINE_AI_SCENARIO_EVIDENCE=1` environment variable before launching Mine Labs:

```powershell
$env:MINE_AI_SCENARIO_EVIDENCE = "1"
try {
  bunx --bun mine-labs run tests/minecraft/scenarios/collect/sand-single.yaml --repeat 1
} finally {
  Remove-Item Env:MINE_AI_SCENARIO_EVIDENCE
}
```

Only the exact value `1` enables retention. Evidence goes under that trial's
Mine Labs artifact directory (`bot-data/` and `<username>/incidents/`) and follows
Mine Labs' run retention. This is a client-host option, not a scenario parameter
or Mine Labs setting. For the dashboard, use the same variable with
`bun run scenarios:spectator`; it applies to every trial in that launched session.

Use the single-action driver for expected success, partial progress, or refusal,
with Mine Labs goals for inventory and world observations. Custom drivers are
for sequences, timing checks, dynamic inputs, or action-specific evidence that
these expectations and world goals cannot express.

A driver exports `run(context): Promise<ClientCompletion>`. There are no
preparation or runtime-configuration hooks. Add capabilities to this contract
only when a real fixture needs them. Shared connection, recording and cleanup
stay in the host.

Run the Minecraft suite once:

```bash
bunx --bun mine-labs run tests/minecraft/scenarios --repeat 1
```

Build the highlighter from the installed dependency and open the spectator:

```bash
bun run scenarios:spectator
```

After building once, `bunx --bun mine-labs run tests/minecraft/scenarios --spectator`
opens the same viewer directly. `spectator.mods` paths belong to the template
declaring them; Mine Labs loads their union for the entire catalog. Changing mods
or their JVM properties requires restarting the viewer. **O** toggles block
highlights; **N** toggles paths. The mod follows reconnects using
`blockhighlighter.serverPortOffset: "10000"`, matching this host's feed mapping.
Both overlays are enabled by default and their preferences persist.
