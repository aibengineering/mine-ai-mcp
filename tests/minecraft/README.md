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
replaceable test logic in `drivers/`, YAML defaults in `templates/`, runnable
cases in `scenarios/`, and faithful fixtures for behaviour that fails today in
`known-failing/`. Point Mine Labs at `scenarios/` or `known-failing/`, not this
whole directory: it recursively discovers every YAML file, including templates.

Group scenarios by behavior: `collect`, `craft`, `build`, `bucket`, `barter`,
`drop`, `explore`, `hunt`, `combat`, `pathfinder`, `portal`, `progression`,
`sleep`, `storage` and `survival`. World type and multi-location
verification belong in the fixture's YAML, so flat and natural-world cases
appear together when reviewing a capability. A fixture's `name` is its file
name without `.yaml`, and Mine Labs lists it as `<folder>/<file>`.

## One action, specified in YAML

Each scenario also declares its purpose in `description` and its type in `tags`:

- `acceptance`: a capability or behavior we expect to work.
- `regression`: a known failure we want to keep fixed; describe that failure too.
- `reliability`: repeated execution exposes marginal movement or control behavior.
- `slow`: End fights, long Nether hunts and anything else over about five
  minutes. It moves the fixture out of the fast tier (see
  [Two tiers](#two-tiers-and-the-known-failing-folder)).
- `known-failing`: the fixture lives in `known-failing/` because the behavior
  fails today. It always comes with `regression`.

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

`expect.status` accepts `succeeded`, `partial`, or `failed`, or a list of them
when the world decides between outcomes: a hunt asked for more than its pen
holds clears the pen and reports `[partial, failed]`, and kill or distance goals
then judge the defeat. Optional
`errorContains` matches literal text, not a regular expression. All conditions
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

Each step takes the same optional `expect` as a single action, and defaults to
success. The sequence stops at the first step whose expectation fails. An
optional leading `waitTicks` delays the first request, for a request made once
an arranged fight is under way:

```yaml
params:
  waitTicks: 40
  actions:
    # A stone cell: the refusal is part of the behavior under test.
    - action: use_bucket
      input: { action: fill, liquid: water, x: 4, y: -60, z: 0 }
      expect: { status: failed, errorContains: "[BUCKET_NOT_A_SOURCE]" }
    - { action: collect_block, input: { block_name: stone, count: 2, scaffold: false } }
```

Final inventory and world assertions stay in Mine Labs goals. Use a custom
driver only when the scenario needs logic beyond an ordered list of calls with
expected results.

For a fixture that requests nothing, select `drivers/idle.ts`. It waits
`params.waitTicks`, or `params.players.<username>.waitTicks` when that player
has one, then reports success. The runtime's reflexes own the body meanwhile,
and the world goals carry the verdict. The host closes the runtime, and its
reflexes with it, once the driver returns, so the wait must cover the whole
arranged hazard.

```yaml
client:
  command: bun
  cwd: ../..
  args: [client-host.ts, drivers/idle.ts]
params:
  waitTicks: 600
```

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

## Pens: several actors in one world

A combined scenario usually places one actor per behavior in a single world.
Mine Labs starts one client per `players[]` entry, each running the fixture's
`client` command with its own username, so every pen runs the same driver and
finds its own request by name:

- **Distance.** Each actor stands in its own walled pen, far enough from the
  others that mobs and tracking cannot cross: about 100 blocks apart for idle
  arenas and 200 for hunts. Cover every pen with `reset`, which on the flat
  template means overriding its small reset region.
- **One request per pen.** `params.players.<username>` holds each pen's request.
  `drivers/action-sequence.ts` reads `{ waitTicks?, actions? }` from it; a pen
  with only `waitTicks` idles, so idle and requesting pens can share a fixture.
  `drivers/single-action.ts` reads `{ action, input, expect? }`, and
  `drivers/idle.ts` reads `{ waitTicks }`. Once `params.players` is present,
  every pen needs an entry and no scenario-level request may sit beside it;
  the drivers reject either mistake, and an entry naming an undeclared player.
- **`who`-scoped goals.** Give every player-observing goal (`completion`,
  `hasItem`, `health`, `survive`, `reach`, `entityDistance`) the pen's `who`, so
  one pen's success cannot stand in for another's. A goal without `who` reads
  only the first player, and `survive` without `who` reads them all.
- **The spectator rule.** `templates/flat-single-action.yaml`'s `tick` rule puts
  every player other than `Actor` into spectator mode. A multi-player fixture
  overrides `tick` with its own names:
  `"gamemode spectator @a[name=!Idler,name=!Worker,gamemode=!spectator]"`.

```yaml
players:
  - { name: Idler, pos: [0.5, -60, 0.5], equipment: { mainhand: iron_sword } }
  - { name: Worker, pos: [100.5, -60, 0.5], inventory: [{ item: stone_pickaxe }, { item: bucket }] }
client:
  command: bun
  cwd: ../..
  args: [client-host.ts, drivers/action-sequence.ts]
params:
  players:
    Idler: { waitTicks: 400 }
    Worker:
      actions:
        - action: use_bucket # a stone cell, refused
          input: { action: fill, liquid: water, x: 104, y: -60, z: 0 }
          expect: { status: failed, errorContains: "[BUCKET_NOT_A_SOURCE]" }
        - { action: collect_block, input: { block_name: stone, count: 2, scaffold: false } }
tick:
  - "gamemode spectator @a[name=!Idler,name=!Worker,gamemode=!spectator]"
goal:
  kind: all
  timeout: 120
  goals:
    - { kind: kill, target: zombie }
    - { kind: survive, who: Idler, seconds: 15 }
    - { kind: completion, who: Idler }
    - { kind: hasItem, who: Worker, item: cobblestone, count: 2 }
    - { kind: completion, who: Worker }
```

## Arranging mid-trial events

The fixture arranges every stimulus in YAML; drivers never stage the world.
Mine Labs offers these shapes:

- **One-shot events.** Top-level `schedule:` entries run once per trial, either
  after a delay or when a vanilla `execute if` condition first holds:

  ```yaml
  schedule:
    - { afterTicks: 100, run: "summon zombie 4.5 -60 0.5 {PersistenceRequired:1b}" }
    - { when: "entity @a[name=Actor,y=-55,dy=10]", run: "effect give Actor slowness 5" }
  ```

- **Starting hunger.** `players[].food` and `players[].saturation` set the
  food bar before the trial, as `health` sets the wound. Saturation is a whole
  number no higher than `food`; declaring either one sets both.
- **Selecting mobs.** `kill` and `entityCount` accept `tag:` and
  `near: { pos, radius }`, so a pen's goal counts only its own quarry:
  `{ kind: kill, target: zombie, tag: pen_east }` or
  `{ kind: entityCount, entity: blaze, near: { pos: [200, -60, 0], radius: 20 }, max: 0 }`.
  Tag the entity with `Tags:["pen_east"]` in its `nbt`.
- **Worn or damaged items.** Inventory and equipment items take item
  components, for example `shield[damage=335]` for a shield one block from
  breaking: `equipment: { offhand: "shield[damage=335]" }`.
- **Upper bounds on items.** `hasItem` accepts `max:`, so a goal can require
  that an item was spent or never picked up: `{ kind: hasItem, item: arrow, count: 0, max: 0 }`.
  `count` defaults to 1, so "none" needs both.

Two vanilla idioms remain:

- **Provoking a neutral mob.** A schedule entry damages it in the player's name:
  `run: "damage @e[type=enderman,tag=pen_west,limit=1] 1 minecraft:player_attack by Actor"`.
- **Anger from the start.** `AngryAt` takes the player's UUID, and servers run
  in offline mode, so the UUID is fixed by the name. Compute it once and paste
  the integer array into the mob's `nbt`, with `AngerTime`:

  ```sh
  bun -e 'const h=require("node:crypto").createHash("md5").update("OfflinePlayer:Actor").digest();h[6]=h[6]&15|48;h[8]=h[8]&63|128;console.log(`[I;${[0,4,8,12].map(i=>h.readInt32BE(i))}]`)'
  # [I;1445601452,1478178322,-1964412895,62273435]
  ```

## Shared setup

Every fixture names one of three templates. They live beside `scenarios/` so
Mine Labs will not discover them as runnable tests, and all supply the Minecraft
version, the viewer mod and the single-action client:

- `templates/single-action.yaml` supplies only those. The fixture arranges its
  own world, reset region and players.
- `templates/flat-single-action.yaml` adds a shared flat world, reset region
  and spectator rule for small flat arenas. The spectator rule expects one
  player named `Actor`; fixtures with other player names override `tick` to
  preserve those participants. The reset region covers the small collect
  arenas; a larger arena must override it.
- `templates/flat-single-action-no-regen.yaml` names `flat-single-action.yaml`
  as its own template and replaces only `world`: the same flat world with
  `naturalRegeneration: false`, so a health goal measures damage the action
  avoided rather than damage healed back. A fixture whose world differs in any
  other way (time, seed, type, difficulty or another gamerule) still declares
  its own whole `world`.

Each fixture declares its own position, equipment and geometry.
The client working directory resolves from each fixture to this suite's root;
the host and driver arguments are relative to that root.
Mine Labs replaces whole top-level fields when merging templates, so a fixture
overriding `world` or `client` must supply that entire field. A template may
name another template (up to four deep); each level replaces whole fields in the
same way.

No template sets `name`, so a fixture's name defaults to its file stem, which
labels its run directory and logs. Fixtures omit `name`; declare one only when
it must differ from the file name.

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

The host builds `createMinecraftRuntime` once. Drivers receive only `scenario`,
the session's `username`, `waitForTicks(ticks)` and `call(action, input)`. The
bot, runtime, cancellation and action recording are owned by the host.
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
  `drivers/action-sequence.ts` and `drivers/idle.ts` are its siblings; the three
  share the per-player envelope and expectation checks in `driver-params.ts`.

Player-arrangement observation uses the shared helper `player-preparation.ts`
beside the host.

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

```sh
MINE_AI_SCENARIO_EVIDENCE=1 bunx --bun mine-labs run tests/minecraft/scenarios/collect/sand-single.yaml --repeat 1
```

Only the exact value `1` enables retention. Evidence goes under that trial's
Mine Labs artifact directory (`bot-data/` and `<username>/incidents/`) and follows
Mine Labs' run retention. This is a client-host option, not a scenario parameter
or Mine Labs setting. For the dashboard, use the same variable with
`bun run scenarios:spectator`; it applies to every trial in that launched session.

Two more host switches change the runtime itself, again only for the exact
value `1`:

- `MINE_AI_SCENARIO_VANILLA_ITEM_USE` moves the bot as the vanilla client does
  while an item is in use: a fifth of the speed and no sprinting behind a raised
  shield, food or a drawn bow. The runtime option is `vanillaItemUseMovement`,
  and the MCP host flag `--vanilla-item-use-movement`. Set it in the shell to
  run a whole suite that way.
- `MINE_AI_SCENARIO_DEBUG_JS` adds `debug_execute_javascript`, for a driver that
  has to hold the body itself.

A fixture that depends on either sets it under `client.env`, as
`combat/raised-shield-movement.yaml` does for both.

Use the single-action driver for expected success, partial progress, or refusal,
the sequence driver for ordered requests, and the idle driver for reflexes, with
Mine Labs goals for inventory and world observations. Custom drivers are for
timing checks, dynamic inputs, or action-specific evidence that these
expectations and world goals cannot express.

A driver exports `run(context): Promise<ClientCompletion>`. There are no
preparation or runtime-configuration hooks. Add capabilities to this contract
only when a real fixture needs them. Shared connection, recording and cleanup
stay in the host.

Mine Labs starts each Minecraft 1.21.4 server with Java 21: `$JAVA_HOME/bin/java`
when `JAVA_HOME` is set, otherwise `java` on `PATH`. If the default Java is
older, point `JAVA_HOME` at a Java 21 installation for the command. The viewer
build below uses the same rule.

## Two tiers and the known-failing folder

The suite runs in two tiers, decided by the `slow` tag. Tag a fixture `slow`
when it fights in the End, hunts at length in the Nether, or otherwise takes
more than about five minutes.

- `bun run scenarios:once`: the fast tier (`--skip-tag slow`) once. It is
  the check to make after changing a fixture, template, driver or the host.
- `bun run scenarios`: the same fast tier, repeated until stopped.
- `bun run scenarios:full`: every fixture under `scenarios/` once, `slow` ones
  included.
- `bun run scenarios:known-failing`: every fixture under `known-failing/` once.

The suite runs on machines people are using at the same time. So every script
runs one trial at a time, and Mine Labs lowers itself, each Minecraft server and
each bot client to below-normal CPU priority before starting. A dedicated
machine can opt out by appending `--jobs N` for parallel workers or
`--normal-priority`, for example `bun run scenarios:once --jobs 2`.

`known-failing/<category>/` holds faithful fixtures for behaviour that fails
today. Neither tier discovers them, because both point at `scenarios/`. Each
carries the tags `known-failing` and `regression`, and its `description` states
the failure as observed. The folders sit at the same depth as
`scenarios/<category>/`, so template and client paths work unchanged. When the
behaviour is fixed, move the fixture into `scenarios/` and drop the
`known-failing` tag.

```bash
bun run scenarios:once

# With a Java 21 that is not the default:
JAVA_HOME=/path/to/jdk-21 bun run scenarios:once
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
