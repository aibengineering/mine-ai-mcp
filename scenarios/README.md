# Mine AI MCP scenarios

The physical layer of the package's tests: the middle of the test pyramid,
where a real world and an external verdict prove what a unit test's fake
cannot, and the ground truth that incident-backed unit tests are recorded
from. The principles behind that split, and their precedents, are in
[docs/mcp/testing.md](../docs/mcp/testing.md).

Live fixtures for this package, run against Minecraft 1.21.4 servers by
Mine Labs. Everything about running one — servers, worlds, cycles,
evidence, retention, spectators, stopping cleanly — belongs to Mine Labs. This directory holds
only what Mine AI knows: which worlds are worth building, and what to ask for in each.

## Goals and diagnostic evidence

Assert outcomes; observe mechanisms. Keep the arrangement, requested task and
verdict separate. A rod acquisition checks inventory and survival, and an exit
goal checks arrival. It must pass whether survival builds cover, changes weapons,
retreats, or uses another permitted approach. Record those decisions in telemetry
and incidents. Do not require a particular response sequence, combat owner,
number of shields raised, or material expenditure.

Drivers submit the task through the production runtime. They do not reissue
requests to compensate for a broken continuation or choose health thresholds and
combat policy on the runtime's behalf. Explicit policy and cancellation tests may
set those inputs because those contracts are their stated subject.

The shared hunter's optional `defeat_count` names an explicit finite-mob defeat
goal. It does not qualify drop acquisition. Acquisition fixtures omit it and
require the requested native inventory gain; kills cannot rescue missing loot.

See [testing principles](../docs/mcp/testing.md) for the distinction
between requested outcomes and diagnostic evidence.

## Arrangement

A scenario file declares everything about its starting state: the world and
its `dimension`, each player's `pos`, `health` and inventory, the arena's
`geometry`, and the native mobs as `entities`. Mine Labs builds and pins the
arena in that dimension, places the player there, and summons the entities
after the client is prepared, so a driver starts measuring from a world that
is already arranged. A driver's own `prepare` export is for what a file cannot
say, such as the state of a dragon fight; it is not for teleports, fills or
summons.

## Two execution classes

Controlled fixtures use `mine-labs run <file-or-folder>`. Add `--jobs N` for parallel workers, `--repeat N` (or `forever`) for repetition, and `--client` for the Mine Labs NeoForge experience. Compatible declared resets reuse a worker's server; `--isolated` forces fresh worlds.

Goal verification in `verification/` uses `mine-labs verify`: one seed and a
list of surveyed absolute spawn locations, with one independent client and result
per location. Compatible separated attempts share a server. Run
`bunx --bun mine-labs verify scenarios/verification --jobs 5`.
Add `--isolated` to replay the identical attempts on fresh individual servers.
Add `--repeat 2` to run another fresh-world batch.

Use `mine-labs run <manifest.yaml> --client` to inspect any verification location. The bundled client connects automatically. Select a scenario or folder, turn Keep running on for a soak, and choose Parallel while idle. Return to Labs cancels the active batch. No CurseForge launch, manual connection, or terminal Enter prompt is required.

The new obsidian and diamond manifests replace the old single-location verification
YAMLs. Their action scripts and independent inventory/completion goals are retained.
Each declares a 256-block horizontal travel radius; Mine Labs fails an attempt
observed outside it and never shares overlapping travel envelopes. Time, rules and
server load are shared; these are integration samples, not isolated timing proofs.
Seed, resolved location, client log, result, and session wall time are retained.

## Layout

Scenarios are grouped by world type and the question they answer. A session can run any folder; Mine Labs checks each next scenario and resets or replaces its server automatically.

### Flat worlds (`flat/`)

| Folder              | Asks                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `flat/collect/`     | can the action collect this, in a world shaped like real work?                                                  |
| `flat/bucket/`      | can the bot scoop a source, trace a flow back to the one feeding it, and pour a full bucket where it means to?  |
| `flat/build/`       | can one build call finish a structure the bot starts inside, from outside?                                      |
| `flat/combat/`      | does the bot meet the declared survival, defeat, travel, and bystander goals under hostile contact?             |
| `flat/evidence/`    | what does every published action return in one real world?                                                      |
| `flat/explore/`     | can the bot physically extend its committed chunk frontier?                                                     |
| `flat/hunt/`        | can a hunt fight a species through the combat controller, sheep to blaze to enderman, and bring the drops home? |
| `flat/sleep/`       | can the bot use, place, and record beds across the sleep lifecycle?                                             |
| `flat/storage/`     | can transfers and last-observed container memory agree?                                                         |
| `flat/survival/`    | does the bot restore hunger, health, and air under the arranged hazards without an explicit rescue request?     |
| `flat/pathfinder/`  | is a dependency behaving the way we believe it does?                                                            |
| `flat/progression/` | do dependent action primitives work from empty inventory to diamond?                                            |
| `flat/water/`       | can the bot survive environmental hazards like deep water?                                                      |

### Default terrain worlds (`default/`)

| Folder                 | Asks                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `default/terrain/`     | can the bot traverse natural generated terrain across chunk frontiers?                                                               |
| `default/progression/` | does the progression to diamond hold on generated terrain, and does a craft that follows a collection still go through?              |
| `default/receipts/`    | does a receipt's inventory count settle inside its deadline where a tick is expensive, rather than only on a superflat world?        |
| `default/observation/` | does a read hold its published contract against whatever a generated world loaded, rather than only against species a fixture chose? |
| `default/hunt/`        | can a hunt walk to an animal the terrain put eighty blocks away and bring its drop home, on generated ground?                        |
| `default/combat/`      | can the emergency hide close a box on ground the generator made, rather than only on ground a fixture laid?                          |

Each scenario names a bot module that connects and drives it. Mine Labs never creates the bot:
whoever calls `createBot` also chooses which mineflayer, and through it which `minecraft-data`
and physics, the run is measured against.

| Module                                                                                                         | Used by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/collector.ts`                                                                                             | `flat/collect/`, `default/obsidian/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/bucketeer.ts`, `src/portal-builder.ts`, `flat/bucket/fill-flowing.ts`, `flat/bucket/pour-through-lava.ts` | `flat/bucket/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/builder.ts`                                                                                               | `flat/build/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/action-evidence.ts`                                                                                       | `flat/evidence/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/explorer.ts`                                                                                              | `flat/explore/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/hunter.ts`                                                                                                | `flat/hunt/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/posture-hunter.ts`                                                                                        | `flat/hunt/cow-terrain-controls`, `flat/hunt/cow-mixed-combat`: the hunt with a posture record beside it - every sneak write with its caller, the server's own sneaking flag and crouching pose - failing on any crouch that outlives a placement; the mixed fixture adds two zombies, a skeleton and a creeper at midnight, iron armor and a shield, so the reflex takes the body mid-hunt the way it does live                                                                                               |
| `src/sleeper.ts`                                                                                               | `flat/sleep/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/storage.ts`                                                                                               | `flat/storage/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `flat/combat/idle-reflex.ts`                                                                                   | idle bow, sword, axe, shield, hand, pack, hurt-threshold, creeper (sword, bow, unarmed, at the foot of a staircase, and a pair met with a bow and without one), skeleton (in contact and at bow range), a zombie on an unreachable ledge, spider (in a fight, ignored in daylight, and hidden from after dark), phantom, enderman (ignored and provoked), a bot already sealed in its own box, and mixed-hostile reflex fixtures (a zombie with a skeleton, and a zombie with a creeper, which is fought last) |
| `flat/combat/standing-down.ts`                                                                                 | `flat/combat/standing-down`: wounded navigation without construction supplies; arrival and survival determine success                                                                                                                                                                                                                                                                                                                                                                                          |
| `flat/combat/combat-handoff.ts`                                                                                | navigation fight, pack, creeper-pair, and gauntlet handoff fixtures: one request per destination, with continuation owned by the production runtime                                                                                                                                                                                                                                                                                                                                                            |
| `flat/combat/busy-reflex.ts`                                                                                   | non-navigation foreground interruption fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `flat/combat/busy-collect-reflex.ts`                                                                           | a mining job interrupted by the reflex (a zombie, or a creeper at the face), then resumed on request                                                                                                                                                                                                                                                                                                                                                                                                           |
| `flat/progression/primitive-progression-to-diamond.ts`                                                         | `flat/progression/primitive-progression-to-diamond`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `flat/pathfinder/long-underwater-exit.ts`                                                                      | `flat/pathfinder/long-underwater-exit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `flat/water/idle-underwater-survival.ts`                                                                       | `flat/water/idle-underwater-survival`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `flat/pathfinder/ore-return.ts`                                                                                | `flat/pathfinder/deep-vertical-ore-return`, `cavern-ore-return`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `flat/pathfinder/pillar-tower.ts`                                                                              | `flat/pathfinder/pillar-tower`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `flat/pathfinder/pathfinder-runner.ts`                                                                         | `flat/pathfinder/carpet-maze`, `diagonal-ascent-staircase`, `flow-hazard-bypass`, `gauntlet-lava-parkour`, `house-door-exit`, `lateral-lava-tunnel`, `obstacle-course-parkour`, `obstacle-course-scaffolding`, `open-cavern-breakthrough`, `pillar-descent-over-lava`, `sand-curtain-tunnel`                                                                                                                                                                                                                   |
| `flat/pathfinder/momentum-step-up-corner.ts`                                                                   | `flat/pathfinder/momentum-step-up-corner`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `flat/pathfinder/leaf-hemmed-diagonal-ascent.ts`                                                               | `flat/pathfinder/leaf-hemmed-diagonal-ascent`, `flat/pathfinder/one-sided-head-bonk-diagonal-ascent`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `flat/pathfinder/soul-sand-parkour-detour.ts`                                                                  | `flat/pathfinder/soul-sand-parkour-detour`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `flat/pathfinder/item-pickup-chase.ts`                                                                         | `flat/pathfinder/item-pickup-chase`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `flat/pathfinder/hostile-corridor.ts`                                                                          | `flat/pathfinder/corridor-detour`, `corridor-forced`, `corridor-dig`: the hostile avoidance field, with `params.field` switching it off for the control run and the driver reporting which lane was walked and what the search cost                                                                                                                                                                                                                                                                            |
| `flat/pathfinder/brute-corridor.ts`                                                                            | `flat/pathfinder/brute-corridor-detour`, `brute-pack-corridor-detour`: the same field against a hostile that cannot be outfought, over three lanes where the middle one is wider than the old twelve-block radius; the driver asserts closest approach against vanilla acquisition range rather than arrival, because the brutes are pinned and arriving proves nothing |
| `flat/pathfinder/route-cancelled-midway.ts`                                                                    | `flat/pathfinder/route-cancelled-midway`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `default/progression/progression-to-diamond.ts`                                                                | `verification/progression/progression-to-diamond`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `default/progression/craft-after-collect.ts`                                                                   | `default/progression/craft-after-collect`: three rounds of collect logs then craft a table and wooden tools in one batch, with the inventory packets kept for the report                                                                                                                                                                                                                                                                                                                                       |
| `default/receipts/settled-counts.ts`                                                                           | `default/receipts/settled-counts-8674349`, `-8675309`, `-20260904`: one eat, one placement, and one craft on three seeded generated worlds, each failing unless the receipt's count moved by exactly what the act was worth with `confirmed: true`                                                                                                                                                                                                                                                             |
| `default/observation/loaded-mobs.ts`                                                                           | `default/observation/loaded-mobs-8674349`, `-8675309`, `-20260904`: one `view_status` read in daylight with mob spawning on, failing unless the loaded-mob summary parses as its published schema, lists something, sorts nearest first, reaches the Markdown, and the live registry loads no mob type the contract omits                                                                                                                                                                               |
| `default/hunt/wild-animal-hunt.ts`                                                                             | `default/hunt/wild-animal-hunt-8674349`, `-8675309`, `-20260904`: reads `view_status` once the fall has settled, hunts the nearest loaded animal it knows a guaranteed drop for, and fails unless the drop arrives and the result names where the animal was                                                                                                                                                                                                                                            |
| `flat/combat/low-health-night-survival.ts`                                                                     | Seven health at midnight, 64 cobblestone, eight active zombies in a ring and one spider. Passes by surviving 20 seconds after setup, with no required strategy or encounter outcome.                                                                                                                                                                                                                                                                                                                           |
| `flat/combat/wounded-cave-ascent.ts`                                                                           | `flat/combat/wounded-cave-ascent`: the 2026-09-09 livelock. Two health, no food, a cavern floor with a staircase to a plateau, and a zombie put on an unreachable ledge eleven blocks off once a withdraw navigate to the plateau is under way. Passes only on arrival alive; the detail tells a second reflex claim after the first hide handed the route back (the loop) from a navigate that returned to the model without arriving.                                                                        |
| `default/terrain/long-haul-terrain.ts`                                                                         | `default/terrain/long-haul-terrain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `default/terrain/night-hostile-haul.ts`                                                                        | `default/terrain/night-hostile-haul-8675309`, `-8674349`, `-20260904`: 120 blocks of generated terrain at midnight with mobs spawning, through the production runtime, so the hostile avoidance field is registered by the session and the contact reflex is attached; `params.field: false` replaces the field with one that supplies nothing, for the control run                                                                                                                                            |

## Commands

Two scripts forward paths and options directly to Mine Labs. Both default to
five parallel workers; an appended `--jobs` overrides that default.

`scenarios` repeats supplied files or folders until stopped. Use `--repeat 1`
for one pass. `scenarios:client` opens the managed client and scenario picker;
its controls select scenarios and repetition. With no paths, Mine Labs opens
the picker rooted at `scenarios`, including when invoked through `scenarios`.

Run these commands from the package root:

```sh
# Soak the regular suites with five workers.
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
`bunx --bun mine-labs verify scenarios/verification --jobs 5`.

## End fight scenarios

The four core scenarios share one crystal-clearing function and one perch-fight
function in `src/ender-dragon.ts`. Cage selection inspects loaded iron bars;
there are no fixed-height crystal or held-perch probe modes.

| Scenario | Sequence | Independently observed goal |
|---|---|---|
| `default/end/crystals-mixed.yaml` | Bow on every exposed crystal, then melee on every caged crystal | Zero crystals |
| `default/end/crystals-bow.yaml` | Explicit bow on every crystal, including cages | Zero crystals |
| `default/end/crystals-melee.yaml` | Spiral staircase on every tower; melee from the covered rim or the tower top, never mining obsidian | Zero crystals |
| `default/end/crystals-melee-pillar.yaml` | Pillar straight up beside every tower; melee from the covered rim or the tower top, never mining obsidian | Zero crystals |
| `default/end/dragon-perch.yaml` | Remove crystals during setup; prepare and attack native perches | Dragon killed |
| `default/end/dragon-bow.yaml` | Remove crystals during setup; repeat one-arrow `shoot_dragon` calls with a configurable hitbox margin | Dragon killed |
| `default/end/ender-dragon.yaml` | Mixed crystal clearing, then the same perch loop | Dragon killed |

```powershell
bunx --bun mine-labs run scenarios/default/end/crystals-mixed.yaml scenarios/default/end/crystals-bow.yaml scenarios/default/end/dragon-perch.yaml scenarios/default/end/ender-dragon.yaml --isolated --jobs 1
```

The common kit and seeded native arena live in `ender-dragon.yaml`; the other
three files supply phase, weapon strategy and goal overrides. The bot has full
health, diamond equipment, arrows, end stone, food and a water bucket. Normal
native dragon AI remains enabled. Background mob spawning is disabled for
these boss scenarios; the recorded first-entry runs retain normal spawning.

There is no client `completion` goal for core fights or loadout replays. Mine
Labs ends the client when the world goal passes, including immediately after
the final crystal disappears. That endpoint does not require descent from the
last tower. The shared driver retries interrupted or unsuccessful actions;
the full fight and perch fight end on dragon death, player death, cancellation,
or the twenty-minute scenario deadline. Neither an individual action timeout
nor a quiet damage chart ends these fights. Their world goals also require
zero recorded player deaths, so unloading the dragon after player death cannot
produce a false victory. There is no intermediate hit-count or preparation goal. Continuous
`fight-observations.jsonl`, `calls.jsonl`, source
identity and runtime incidents retain evidence even when a world goal stops
an in-flight action before its final receipt.

Core dragon fights also write `perch-decisions.jsonl` continuously. It records
the selected perch branch and a two-second heartbeat during pending effects,
including positions, estimated head/reach, hazards, endpoint rejection counts,
route results, cached-failure retry conditions and cooldown/bystander waits.
Join `callSequence` to `calls.jsonl`; `decidedAtMs` timestamps the branch details
while `atMs` timestamps the accompanying live body/hazard snapshot. Endpoint
counts use the first rejecting condition and stop at the first geometrically
usable position; they do not claim a traversable route or visible sword hit.

Three focused physical regressions remain:

- `bucket-native-knockback.yaml`: TNT launches the bot; it must land without
  fall damage and recover its water bucket.
- `landing-idle-escape.yaml`: native landing defense when the runtime is idle.
- `perch-enderman.yaml`: hostile interruption and resumption of the same perch request.

`dragon-post-crystal-replay.yaml` preserves the recorded seed-64510673
post-crystal combat kit, worn equipment, start and 190-health dragon. Only its
setup differs from the generic perch fight; it reuses the common runner.

`default/end/claude-first-entry.yaml` repeats the seed 81360492 dragon arena
with every recorded first-fight inventory slot, count, and durability, including
the full water bucket, diamond armour, 15 cooked food, and no arrows. It starts
on the island surface; Claude's recorded underground inspection depended on
previous excavation. Enchantments and XP were not recorded. The TypeScript
caller clears junk, mines end stone as needed, returns to its surface staging
area, destroys crystals from lowest to highest, then calls perch preparation
and attack. A partial collection caused by missing drops is usable inventory;
the caller requires stock to increase before considering another collection.
It stops on the first death or other unsuccessful action, with a three-minute
limit per action. Setup uses
commands to restore equipment; measured gameplay uses production actions.
Run `bunx --bun mine-labs run scenarios/default/end/claude-first-entry.yaml --jobs 1 --repeat 2 --isolated`.
The `first-entry-64510673.yaml` and `first-entry-8675309.yaml` variants inherit
the same complete loadout and caller, changing the seed and surveyed surface
start. Cycle all three with:

```powershell
bunx --bun mine-labs run scenarios/default/end/claude-first-entry.yaml scenarios/default/end/first-entry-64510673.yaml scenarios/default/end/first-entry-8675309.yaml --jobs 1 --repeat 2 --isolated
```

The former single-tower, cage-height, bucket-descent and staged-perch variants
have been absorbed into these complete sequences. The stone-pickaxe first-entry
replay traverses the wide tower as part of its full crystal sequence. Recorded
first-entry loadouts and both seed variants remain intact and share the crystal
and perch functions, with their original resupply and survival-policy setup.
Ordinary gaze/target selection now lives in `default/combat/enderman-gaze.yaml`
and `flat/combat/enderman-other-target.yaml`; scaffold policy lives in
`default/terrain/scaffold-end-stone.yaml`.

`flat/survival/bucket-fall-40-edge.yaml` reproduces a body-edge collision with
a raised full block beside a lower centre column. It requires full health,
native water placement/removal and the recovered bucket. Keep this beside the
ordinary fall, horizontal-launch and planned bucket-descent controls when
qualifying changes to landing prediction.

`flat/survival/bucket-fall-corner-drift.yaml` reproduces the diagonal raised
corner from an eighth-tower fatal fall. `flat/pathfinder/bucket-drop-displaced.yaml`
injects the recorded downward/sideways hit during a planned drop: the landing
must follow the displaced body, retain full health, recover the water and
finish the original route. These use the existing fall and navigation drivers.

The fight drivers retain source identity, calls, one-second fight observations,
SQLite events, and incidents. First-entry replays use a 512 MiB incident cap per trial. Review a failure
before starting further repetitions; a stopped action is not itself proof
of a fatal combat bug.

## Recommended end-to-end qualification

`primitive-progression-to-diamond` is the single-run acceptance test for the current action
primitives. It starts a player with an empty inventory on a peaceful, seeded, authored world and
runs one dependent sequence: logs, crafting table placement, wooden tools, dirt, stone, table
return, stone tools, furnace placement, coal, raw iron, smelting, an iron pickaxe, and finally
diamond. Mine Labs checks both placed workstations and the final inventory independently, while the client reports the first action stage
that failed and retains Pathfinder telemetry in the run report.

Run it after focused tests when collection, crafting, placement, tool selection, movement, goal
revalidation, or action-session behavior changes:

```bash
bunx --bun mine-labs verify scenarios/verification/progression --jobs 5
```

This is the strongest compact integration signal, not a replacement for the focused physical
fixture that reproduces a particular failure.

## Pathfinder scenarios

Every fixture uses the package-local navigation attached by the production bot
host. There is no other engine to select: the `mineflayer-pathfinder` baseline
and its comparison script were removed on 3 September 2026, for the reasons in
[the navigation library README](../docs/navigation/README.md#one-engine-on-purpose).

Six fixtures exist because production navigation does something the rest of
the set never asked for:

| Fixture                               | The angle nothing else covers                                      |
| ------------------------------------- | ------------------------------------------------------------------ |
| `item-pickup-chase`                   | a goal that moves under the route, and one that invalidates itself |
| `route-cancelled-midway`              | `stopSignal` cancellation, and reusing the pathfinder afterward    |
| `long-haul-terrain`                   | generated terrain, unloaded chunks, segment continuation           |
| `momentum-step-up-corner`             | speed inherited across a movement boundary                         |
| `leaf-hemmed-diagonal-ascent`         | unsafe diagonal ascent rejected in favor of cardinal stairs        |
| `one-sided-head-bonk-diagonal-ascent` | asymmetric upper-corner obstruction rejects an unsafe rise         |
| `soul-sand-parkour-detour`            | shortened takeoff range routes around a three-block gap            |

## The three kinds of scenario

**Collection scenarios** assert on evidence Mine Labs observes independently — inventory gained,
a block still standing — never on the action's own report. `src/collector.ts` also accepts
`expect: refused` with `because: "<substring>"`, so a world built to prove the bot _declines_
something fails if it collects anyway.

**Exploration scenarios** combine independent movement goals with the action's completion signal,
so a frontier expansion cannot pass by merely reporting success while the bot stays at spawn.

**Sleep scenarios** inspect the live client after the action settles: world time must actually
reach morning, the server-reported spawn point must move near the bed, and a carried bed must
appear in the constrained fixture cells. The action's own result is necessary, but is never the
only evidence.

**Storage scenarios** compare the action result and SQLite snapshot with a fresh Mineflayer
container observation, while Mine Labs independently verifies the final bot inventory.

## Known disagreements

`water/idle-underwater-survival` checks survival and health for 40 seconds after
spawning in a submerged pool without a rescue request. Recovery choices remain
runtime policy.

The ore-return pair runs the same Mine AI MCP workflow against two ordinary terrain shapes. In
both, the bot must mine three buried ore, navigate back through its excavation, deposit the drops
into a surface chest, then independently compare the physical chest with container memory.

- `pathfinder/deep-vertical-ore-return` stresses repeated placement on a steep return.
- `pathfinder/cavern-ore-return` opens the authored tunnel into a cave and retains the
  historical stalled-return shape as a regression for the local executor. Run these fixtures
  for multiple cycles when qualifying movement changes; one pass is not a reliability verdict.

## Spectating

Run `bun run scenarios:client`, or `mine-labs run <path> --client`. The bundled
NeoForge client opens the catalog, connects to the prepared server, and places
the spectator above and behind the bot before execution. F10 opens the dashboard;
Keep running, Repeat, and Parallel control subsequent runs. Return to Labs cancels
the active batch while keeping the selector open. The control API uses an
automatically allocated loopback port. Plain `run <path>` remains headless.

The Block Highlighter mod draws the bot's route and the action's own reasoning — candidates,
refusals, the selected target, the settling drop — polled from the host feed. `N` toggles the
route, `O` toggles highlights.
