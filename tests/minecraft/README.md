# Minecraft scenarios

Each fixture owns three things: the world and player arrangement, the action
request, and the expected outcome. This suite does not inherit from the old
`flat/` or `default/` fixtures.

Everything for this suite lives here: shared host files at the top level,
replaceable test logic in `drivers/`, YAML defaults in `templates/`, and runnable
cases in `scenarios/`. Point Mine Labs at `scenarios/`, not this whole directory:
it recursively discovers every YAML file, including templates.

## One action, specified in YAML

For example, `collect/coal-outcrop.yaml` asks:

```yaml
params:
  action: collect_block
  input:
    block_name: coal_ore
    count: 5
    scaffold: false
```

`drivers/single-action.ts` reads that envelope, calls the named action
once, and reports whether it succeeded. Any action registered by the runtime
can be selected; there is no action-specific driver or switch statement.
Use `input: {}` for an action with no arguments. Action schemas validate the
input; the driver validates only the `action`/`input` envelope.

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

Fixtures using it live in `scenarios/<category>/` and name their
single player `Actor`. Each declares its own position, equipment and geometry.
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
- `drivers/single-action.ts`: read the YAML request, call the action, and require success.

Player-arrangement observation still uses the shared helper at
`../../scenarios/src/player-preparation.ts`. It remains there so the old suite's
imports and behavior are preserved; this suite does not duplicate that logic.

`runWithRuntime` creates the runtime and waits for the start signal before timing
the driver's run. Preparation
errors reach Mine Labs' client error handler; execution errors become failed
completions with elapsed time. Cancellation unwinds cleanup without reporting a
second outcome for a trial Mine Labs has already stopped.

This suite tests actions directly through `runtime.run()`, with the runtime's
navigation, reflexes, survival and incident recording. It does not exercise MCP
transport, async submission IDs, or the submit/wait/result-retrieval protocol.
Its call-log entries contain the action input and output, not MCP replies.

The host adds no navigation tracing, heading analysis or memory sampling.
Future diagnostics can subscribe to `runtime.navigation.onEvent(listener)`
and use the returned function to unsubscribe. There is no host extension
framework until a concrete diagnostic needs one. Built-in incident recording
and progress tracking remain part of the runtime.

The generic single-action driver expects success. A scenario whose purpose is
an expected refusal needs its own result assertion; failure is never silently
treated as passing. Add declarative refusal expectations when migrating that
first case, keeping them separate from action input.

A driver exports `run(context): Promise<ClientCompletion>`. There are no
preparation or runtime-configuration hooks. Add capabilities to this contract
only when a real fixture needs them. Shared connection, recording and cleanup
stay in the host.

Run the new collect suite once:

```bash
bunx --bun mine-labs run tests/minecraft/scenarios --repeat 1
```

The old tests remain available for separate comparisons.
