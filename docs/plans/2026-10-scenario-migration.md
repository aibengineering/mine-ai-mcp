# Legacy scenario migration ledger

October 2026. This ledger decides the fate of every fixture in the legacy catalogue `scenarios/`:
446 YAML fixtures and 238 fixture-local drivers. The consolidated suite in
[tests/minecraft/](../../tests/minecraft/README.md) replaces it. Once every row here is resolved,
`scenarios/` is removed.

The principles come from [docs/mcp/testing.md](../mcp/testing.md): assert outcomes and observe
mechanisms; drivers request actions and never choose policy for the runtime. The new driver contract
([tests/minecraft/scenario.ts](../../tests/minecraft/scenario.ts)) gives a driver only `scenario`,
`waitForTicks` and `call(action, input)`. A legacy fixture that worked by building its own combat
controller or driving navigation directly cannot be ported as it is. It either becomes a black-box
request with world goals, or its incident moves to a unit test, or it goes.

## Outcome

The migration finished on 2026-10-20 and 21. Every row below is resolved,
`scenarios/` and `scenario-templates/` are gone, and the legacy-only unit tests
went with them. The tables further down are the plan as triage made it; this
section records what was built and where it differs.

**The suite now:**
- `tests/minecraft/scenarios/` holds **113 fixtures**, up from 35, after the
  flake investigation returned `end-crystals-staircase`. 103 of them form the
  fast tier. The 10 tagged `slow` form the rest of the full tier: the End
  fights, the long Nether pearl hunt, and the two multi-location generated
  worlds, which expand into 13 trials.
- `tests/minecraft/known-failing/` holds **18 fixtures** for behaviour that
  fails today, described as observed; it held 24 before the flake fixes.
  Neither tier runs them.
- Most consolidated fixtures place one bot per walled pen, each with its own
  request and `who`-scoped goals. Each is either shown to fail when a pen is
  made impossible or a goal tightened, or carries a stated reason why its goals
  catch a regression. The category commits list both.

**Measured runtime, one trial at a time at below-normal priority:**

| Run | Trials | Time | Result |
| --- | ---: | ---: | --- |
| Fast tier (`scenarios:once`), first run | 103 | 81 min | 100 passed. The three failing fixtures each had pens that later failed again in reruns; those pens moved to known-failing |
| Fast tier, confirming run at b2e79c1 | 103 | 81 min | 99 passed. The four failures were each a pen that passed in the other run: a two-netherrack disposal miscount, an unreachable magma cream, an unsafe handoff after a fortress rod, and CliffBot slain by an enderman |
| Slow tag (`--tag slow`) | 13 | 40 min | 11 passed. `end-crystals-staircase` then failed two of three reruns and moved to known-failing; `end-crystals-every-method` passed twice on an idle machine |
| Known-failing (`scenarios:known-failing`) | 24 | 100 min | 19 failed as described. The five intermittent ones passed this time, among them the first-entry fight. `basalt-crossfire-wounded` errored on a stale driver path, since fixed; it fails as described |

The full tier is the fast and slow runs together, about two hours one trial at
a time. Each fast-tier run fails a few percent of its trials, and the failing
fixtures differ from run to run. Every one of them is a runtime behaviour
that usually holds: none is a fixture error. A single fast-tier run is
therefore rarely all green.

Decided on 2026-10-21: intermittent fixtures stay in the fast tier with their
flake rate documented, and are not quarantined. A fixture that fails reliably
goes to known-failing. The seven fixtures seen failing in the two fast-tier
runs:

| Fixture | Pen that failed | Failure | Runs |
| --- | --- | --- | --- |
| `combat/creeper-reflex` | PairBow | A creeper of the pair left alive after hit-and-run | Failed 3 of 3; the pen moved to known-failing |
| `combat/enderman-hunt` | Alcove, ShelterPair | `[COMBAT_BUILD_MATERIALS_MISSING]`: an enderman left alive | 2 of 4; the pens moved to known-failing |
| `combat/wounded-ranged-shelter` | Burning, BlazeShelter | Burned to death, or recovered only to 15.7 | 2 of 3; the pens moved to known-failing |
| `drop/disposal-holes` | Full | 2046 of 2048 netherrack, the legacy miscount | 1 of 2 tier runs; stays |
| `hunt/basalt-magma-cream` | CreamHunter | `targets_unreachable`, no cream | 1 of 2 tier runs; stays |
| `hunt/fortress-rod-and-exit` | FortressBot | Rod taken, then an unsafe handoff with no shelter floor; never reached the exit | 1 of 2 tier runs; stays |
| `survival/nether-idle-survival` | CliffBot | Slain by the enderman angry at it | 1 of 2 tier runs; stays |

The first three were split before this decision, because their pens failed
again in reruns. The last four stay in the fast tier as they are, and their
behaviours have proposed fix sessions.

**Harness changes the migration needed:**
- **Mine Labs** gained six features: `schedule:` one-shot commands,
  `players[].food`/`saturation`, `tag` and `near` on `kill`/`entityCount`, item
  components in inventory and equipment, `hasItem.max`, and `--tag`/`--skip-tag`
  on `run` (616a8af). It now runs below normal CPU priority by default
  (cdca91c).
- **ScenarioContext** carries the session's `username`, so each pen finds its
  own request under `params.players.<name>`.
- **Shared drivers:**
  - `idle.ts` waits.
  - `action-sequence.ts` takes per-step `expect`, a leading `waitTicks`,
    `idleWithinTicks` (wait for no reflex to own the body, then ask once), a
    trailing `holdTicks`, `forbidResponses`, and fills in the survival policy
    revision.
  - `pathfinder-course.ts` replaced `navigate-route.ts` for every route course.
  - Scenario-specific drivers remain where a fixture needs logic beyond a
    sequence: End fights, the Nether rate hunt, the workshop and storage
    checks, and a few others.
- **Player preparation** reads item-component stacks by their base id.

**Fates changed during implementation** (the category commits give the details):
- `ocean-sand-shaft` and `hide-close-intruder` pass now and are green, not
  known-failing.
- **Split into known-failing.** These rows were planned for green scenarios,
  but their behaviour failed at least twice or flaked:
  - `vine-column-handoff`;
  - `lava-advances-during-dig`;
  - the waterfall-oak live stall;
  - the tunnel disposal hole;
  - one cast-obsidian location;
  - the bed exit after waking;
  - three lava escapes;
  - `busy-smelt-interrupted`;
  - the crossfire hunt in cover-fights;
  - side-bridge;
  - the skeleton arena;
  - `full-night-request`;
  - the enderman beside another mob's fight;
  - the bow-armed creeper pair;
  - two wounded-under-blaze shelters;
  - the alcove and short-of-blocks enderman hunts;
  - the wounded basalt crossing;
  - the magma-cream islands;
  - the run-14 fortress rod hunt;
  - the spawner rod rate;
  - the first-entry dragon fight;
  - the bow-only dragon kill;
  - the staircase-only and pillar-then-staircase crystal fights.
- **`fortress-sortie`** stays its own green hunt, because the run-14 room it was
  to fold into fails.
- **`end-crystals-staircase`** was added beside `end-crystals-every-method`. It
  later flaked and moved to known-failing.
- **`underwater-current`** became a pen of `pathfinder/water-course`.
- **`wounded-pocket`** moved to `combat/wounded-navigation`.
- **Two moves between combat fixtures:** `low-health-night-survival` went to
  `combat/evade`, and `fight-yields-when-hurt` to `combat/wounded-hide`.
- **Legacy driver checks recast as world goals:**
  - the brute corridor's closest-approach check is now a tick-command latch;
  - knockback-ledge's position limit is now a below-the-perch marker;
  - `bed-lifecycle` keeps its two respawn points in separate pens.
- **The magma-cream sword carries Looting III.** Legacy killed 31 cubes for no
  cream, so the failure was the pickup, not drop luck.
- **`nether-gravel-overhang`** accepts either taking the ore safely or refusing
  it. Its health and survive goals judge the safety.

**Not migrated as scenarios, deliberately:**
- the fake-velocity bucket falls and `swim-physics`;
- the diagnostic probes: `arrow-position-freshness`, `dripstone-wedged-raw`,
  `parkour-pillar`, and the `manual/runtime` hang probes, whose incidents
  `runtime-supervisor.test.ts` pins;
- the 79 unit-test rows, each pinned by the named test.

The vine-column-handoff fix an agent wrote is saved as a patch for its fix
session. It is not applied: it makes the lateral step complete, but the next
climb still fails.

### Known-failing and proposed fix sessions (as of 2026-10-20)

The flake investigation below fixed several of these and moved them back into
the suite; its "Known-failing now" table is the current list.

| Fixture | Observed failure | Fix session |
| --- | --- | --- |
| `collect/cast-obsidian-spawn-column` | The route to the obsidian dives and runs out of its breath budget; the breath reflex cancels the collection | Dive breath budgets on collection routes |
| `combat/basalt-crossfire-wounded` | At 11 health, an evade or hide response cancels the navigate short of the marker | Wounded navigation under reflex claims |
| `combat/busy-smelt-interrupted` | `smelt_item` returns cancelled by `[HOSTILE_CONTACT]` instead of resuming the cook | Resuming foreground work after a fight |
| `combat/cover-crossing-hunt` | Below its fight bar, a blaze hunt loops between approach and evade until the timeout (intermittent) | Hunts that cannot continue should return |
| `combat/creeper-pair-bow` | One creeper of a pair is left alive after hit-and-run carries the bot out of range (intermittent) | Re-engaging a threat after retreat |
| `combat/end-crystals-pillar-then-staircase`, `combat/end-crystals-staircase` | The staircase to the caged crystal at -33.5,83,-24.5 stalls, or the bot dies partway (intermittent) | Crystal staircase routing |
| `combat/ender-dragon-bow` | `shoot_dragon` is mostly `[DRAGON_SHOT_BLOCKED]`; the dragon lives 30 minutes | Bow dragon intercepts |
| `combat/ender-dragon-first-entry` | The recorded loadout runs short of end stone for the staircase or fails to step out of it; passed once in 34 min (intermittent) | Crystal staircase routing |
| `combat/enderman-hunt-short-of-blocks` | The hunt returns `capability_blocked` with `[COMBAT_BUILD_MATERIALS_MISSING]` once its blocks run out (intermittent) | Enderman hunts without blocks |
| `combat/enderman-other-target` | The reflex fights an enderman angry at another mob after it turns its head toward the bot (intermittent) | Enderman threat attribution |
| `combat/full-night-request` | A hide response ends a pending hunt's observation window about 90 s into the night | Resuming foreground work after a fight |
| `combat/navigation-side-bridge` | The navigate never finishes the bridge crossing under skeleton fire | Navigation under ranged fire |
| `combat/skeleton-arena-crossfire` | The bot arrives but has been hit (intermittent) | Navigation under ranged fire |
| `combat/wounded-ranged-shelter-flaky` | A wounded bot under blazes burns to death or recovers short of 18 (intermittent) | Wounded shelter under blaze fire |
| `drop/disposal-hole-tunnel` | The hole holds one or two more cobblestone than the receipt reports | Disposal accounting |
| `hunt/basalt-magma-cream-islands` | The island hunt touches lava, stands on magma, and runs on for minutes | Magma-cube hunts on basalt |
| `hunt/fortress-rod-and-exit-run14` | The rod hunt stalls on a broken shield or `capability_blocked` (intermittent) | Fortress blaze hunts |
| `hunt/fortress-spawner-rods` | A fire takeover or worn-out shields leave rods under one per minute | Fortress blaze hunts |
| `pathfinder/flowing-lava-dig-release` | Lava released on landing burns the bot to death after the fire reflex interrupts the route | Lava and fire escapes |
| `pathfinder/vine-column-handoff` | A lateral step onto a lower vine column never arrives; the body slides into lava (a partial patch is saved) | Vine column handoff |
| `sleep/bed-exit-after-waking` | After waking, navigate finds no path off the bed | Pathing off a bed |
| `survival/lava-escapes` | The pool bot climbs out but, with no water, ends at 1 health at best, below the goal's 2; the pocket and dig pens are fixed and back in `survival/fire-reflex` | Lava and fire escapes |

### Runtime findings without a fixture

- **`collect_block` counts other players' broken blocks.** It counted blocks
  another player broke 95 blocks away against its own break budget, so pens
  doing the same block work stand 200 apart.
- **`collect_block` doesn't refuse a missing block.** Asked for a block absent
  from the world, it ran until the trial timed out.
- **Reflexes take the body before the first request.** The runtime's reflexes
  are live before a trial starts, so a hostile within 8 blocks of a start takes
  the body first and the first request is refused `[ACTION_BUSY]`. Fixtures
  either start bots further away or use `idleWithinTicks`.
- **Two unit tests flaked under load:** "cancelling while a second ceiling
  still pins the body releases the observation wait", and "a target
  oscillating between two cells…" in `navigation-run.test.ts`. Fixed in
  f445cd8: the navigator takes a search clock the tests stand still.
- **`end-crystals-every-method` failed once under load** at the staircase to
  the caged tower. Its staircase causes were fixed in 18d4135, d3f5080 and
  74a2f9d.
- **A request a reflex handed back unfinished reported `cancelled`,** which the
  model could not tell from its own cancellation. Since f453caf it reports
  `failed` with the reflex's reason; only a model or operator cancellation
  reports `cancelled`.

## Flake investigation (2026-10-21)

The user asked for the cause of every intermittent failure to be found and
fixed, not retried or quarantined. Each fix below either has a unit test that
failed before it, or is named as a harness or fixture fix. Each was proven by
repeated live runs: five passes in a row, or two for End fights.

| Flake | Root cause | Where | Fix |
| --- | --- | --- | --- |
| Lava pocket escape (PocketBot) | Equally near banks were taken in scan order, so the escape could pick a bank cut off from the water and stand down while the burn ran | runtime | 097b379 |
| Lava escape in general | The escape released a burning body still overhanging the lava on its bank's lip | runtime | 20d2a13 |
| `drop/disposal-holes` (2046 of 2048) | With every slot full, the hole's plug could spend the netherrack the request was keeping, depending on whether the dug cobblestone was picked up first | runtime | 9a7cab5 |
| Waterfall oak stall | A body floating 0.27 above its stance in waterfall water dug five times slower, so the log timed out and was abandoned | runtime | 9cbf1b0 |
| Two unit tests under load | Search slices ran on the wall clock, so an overrun slice changed what the tests observed | test | f445cd8 |
| `combat/enderman-other-target` | An enderman angry at another mob glances at nearby players; the threat check read that glance as an attack | runtime | a3de1c4 |
| `combat/creeper-reflex`, PairBow | The escape sprint left one creeper beyond its follow range, and nothing went back for it after the first kill | runtime | a05b3a7 |
| `survival/nether-idle-survival`, CliffBot | A wounded bot without food could only evade an angry enderman, which teleports to its target | runtime | 59e7b83 |
| `combat/wounded-ranged-shelter`, Burning | A burning bot at hunger 19 never ate, because the hunger reflex fed wounded bots only below 18 | runtime | 2e5409f |
| `combat/evade`, CubeEvade | A cornered hide dug the block beside lava under the bot's feet | runtime | 30d0f72 |
| Skeleton death in `combat/creeper-navigation` | A bot with no pickaxe spent seven seconds hand-digging stone for a shelter under fire | runtime | c383c1b |
| `combat/enderman-hunt`, ShelterPair | A hunt out of blocks looked for roofs only six steps away and missed the one it had built | runtime | 7d118cd |
| `combat/enderman-hunt`, Alcove | An enderman stalled behind the alcove's own wall was never baited out | runtime | c77ef28 |
| `combat/cover-crossing-hunt` (improved) | Melee fights were admitted too late for the shield, ended with a partner still in reach, and handed the body back before the next attacker was answered | runtime | 078f060, 895f6cb, de88a57, 2d9187a |
| Waits failing under load (several fixtures) | The host's tick wait failed on wall-clock time when the client ran slow | harness | 6707927 (supersedes 8fdff05) |
| `hunt/basalt-magma-cream` | The hunt followed cubes down to the lava shore, one drop at a time | runtime | a667ddb, 7391707 |
| `hunt/fortress-rod-and-exit` (unsafe handoff) | The shelter and handoff checks used the cell under the body's centre, which can overhang an edge | runtime | 3e9f6c2 |
| Run-14 hunts never made their request | Blazes pinned in contact range of the start took the body first | fixture | d7e885a |
| Resumed hunt refused with its drop in hand | A shield broken in a reflex fight refused a hunt that had already succeeded | runtime | 347d33f |
| `end-crystals-staircase` and every-method | A dragon shelter left blocks on the attack line; breath beside the feet closed the stair routes; the dig stance was judged from the cell centre, not the body | runtime | 18d4135, d3f5080, 74a2f9d |
| End arrangement checked too early | The driver judged the crystals before they reached the client | driver | 7854cb8 |
| First-entry: breath above the stairs, a builder in a needed cell, a climb that spun | Three runtime causes found on the way | runtime | 65e7ab7, 0f84668, 0c8f7ae |
| `place_block` choosing a mob's cell (`hunt/wild-animal-and-receipts`) | A placement with no coordinates chose the nearest cell before checking it for bodies, and a wandering pig sometimes stood there | runtime | 1b50a97 |

**Load.** With four agents at `--jobs 4`, client physics fell to 13–15 ticks a
second and clients froze for 2–5 s, which caused failures of its own. Those
were not counted as samples. A suite run alone at `--jobs 4` keeps about 19.5
ticks a second.


### Final fast-tier runs (2026-10-21, both at c383c1b, `--jobs 4`, no game running)

| Run | Time | Result |
| --- | ---: | --- |
| 1 | 22.5 min | 100 of 103 passed. Failures: `skeleton-crossfire-navigation` (Elevated pen hit by an arrow), `awkward-quarry` (PinnedHunter never observed its arrangement while the server ran 4.3 s behind), `wild-animal-and-receipts` (the pig, fixed in 1b50a97) |
| 2 | 22.75 min | 97 of 103 passed. Failures: `basalt-crossfire-traverse`, `cover-fights`, `creeper-navigation`, `creeper-reflex`, `basalt-magma-cream`, `tool-tier-progression` (one of five iron drops never recovered) |

**Server lag adds failures at `--jobs 4`, but it is not the main source.**
At `--jobs 4` the server logged "Can't keep up!", running 2 to 4 s behind, in
15% of passing trials and in 6 of 9 failing ones.

Two more runs at `--jobs 2`, both at 6a96fdd, tested whether fewer workers
would remove the failures:

| Run | Time | Result |
| --- | ---: | --- |
| 1 | 41.6 min | 97 of 103 passed |
| 2 | 40 min | 101 of 103 passed |

Lag was rare (10 of 206 trials), and no failing trial lagged. The eight
failures were all runtime behaviours:
- `collect/netherrack-bank`: 31 of 32; a dropped item was never recovered, the
  same as in `tool-tier-progression`.
- `combat/cover-fights`, Transit: a blaze `targets_unreachable`.
- `combat/skeleton-crossfire-navigation`, Elevated: hit by an arrow.
- `hunt/basalt-magma-cream`: cream collected, then the bot touched lava on
  the shore.
- `hunt/skeleton-hunts`, BoneGatherer: 2 of 3 bones, then
  `no_loaded_targets`.
- `survival/fire-reflex`, MinerBot: never reported completion.
- `combat/withdraw-navigation`, Blazes: never reached the bridge's end after
  `defend_only`.
- `combat/wounded-ranged-shelter`, Unbuildable: recovered only to 16.95.

Across those four runs, the fast tier failed about 4% of its trials.

### Third round (2026-10-21)

| Flake | Root cause | Where | Fix |
| --- | --- | --- | --- |
| Basalt crossing ended mid-route | A deflected fireball that burst or passed without an observed reversal counted as a capability limit, so the interrupted navigate was ended, not resumed | runtime | 378f36e |
| Withdraw navigation, Blazes | Under `defend_only`, a fight with a blaze that hovered out of reach never ended | runtime | 890403c |
| Withdraw navigation, Blazes (refused navigate) | The navigate went out the instant the policy change released the fight, while a reflex had just re-claimed the body | harness | ece906e: steps can wait for an idle body |
| Creeper navigation, Cave | With shelter and healing impossible, the engagement returned a recovery limit while the skeleton kept shooting | runtime | ae8a0ea |
| Creeper navigation, Cave (second mode) | A creeper walking in while the bot fought another enemy got no retreat until its fuse lit | runtime | d695746 |
| Skeleton crossfire, Elevated | The walking guard judged cover from the route's facing, but a drawn arrow enters where the body will be at impact | runtime | 2e6c45e |
| Skeleton crossfire, finished pens | A pen's skeletons outlived its request, and with it the bot's reflexes | fixture | d8c0d56 |
| Wounded ranged shelter, 15–17 health | Health was read at a fixed moment while the pen still dueled a blaze. It now counts recovery to 18 at any point under fire, then clears the shooters | fixture | c7be072 |
| Cover fights, Transit | A blaze holding above sword reach was abandoned seconds before it came down | runtime | 5cb4b6b |
| Skeleton hunts, bones short | Cover searches on open ground restarted each second until the shield broke; a broken shield refused bones already on the ground; native loot sometimes gave fewer than three bones | runtime, runtime, fixture | 0f4871a, 8681835, 9324030 |
| Netherrack bank 31 of 32 | Breaking continued beside drops that already covered the request, spending the spare breaks meant for lost drops | runtime | a043508 |
| Fire reflex, MinerBot | After the escape, the obsidian's drop could roll into lava left in the hole, and collection then explored past the trial | runtime | 0dd02e9 |
| Cast obsidian, location 1 | A pour onto short grass lands one cell up, so the water landing never confirmed itself | runtime | deb4bc3 |
| Tool-tier lost iron | A drop resting in a one-block cliff notch had no satisfying stance for pickup | runtime | fade428 |
| Preparation stalls (awkward-quarry) | Not reproduced. Preparation now logs which stage and conditions it waits on | harness | edde8ed |

Two confirming fast-tier runs at 1e51ef6, after the third round:

| Run | Workers | Time | Result |
| --- | --- | ---: | --- |
| 1 | two | 44 min | 102 of 103 passed: `creeper-reflex` PairBow left a creeper alive (a05b3a7 made it rarer, but not gone) |
| 2 | one (a game had started) | 85 min | 102 of 103 passed: `fortress-rod-and-exit` did not finish within 300 s (new mode) |

Neither failing trial lagged. The fast tier now fails about 1% of its
trials, down from about 4%.

Still open:
- **CubeEvade**, rare: a cube hopping into the planned route. A patch is
  saved, but it never fired live, so it is not merged.
- **Opposing skeletons**, rare: arrows landing in the same tick from opposite
  sides need positioning.
- **`withdraw-navigation` Sealed:** a reflex-returned request reported
  "cancelled", which the harness fails. Decided 2026-10-21: such a request now
  reports `failed` with the reflex's reason (f453caf), and the fixture passed
  five in a row.
- The two failures above.


### Still flaky, with known or suspected cause

- **Combat:**
  - `combat/creeper-navigation` (Cave): fixed in ec65068 (a bow drawn with a
    zombie closing; see the confirmation-pass fixes). What remains is rarer:
    arrows in the back during the creeper escape can still take Cave to the
    bar.
  - `combat/skeleton-crossfire-navigation` (Elevated) and known-failing
    `skeleton-arena-crossfire`: arrows released within two ticks from
    opposite sides. One shield arc cannot cover them; the fix is positioning
    that keeps shooters within one arc.
  - `combat/evade` (CubeEvade), 1 in 10: a magma cube's blow during the
    evade; no evidence covered the hit.
- **Load-sensitive:**
  - `hunt/awkward-quarry`: under server lag, the bot pinned under a big
    dripleaf missed its arrangement window.
  - `progression/tool-tier-progression`: under lag, a drop's recovery found no
    path.
  - Run 2's other failures were lagged runs of fixtures that pass when the
    server keeps up.

### Confirmation pass (2026-10-22, at 49678c6, `--jobs 2`, no game running)

| Run | Time | Result |
| --- | ---: | --- |
| Fast tier | 40 min | 102 of 103 passed |
| Slow tier | 19.4 min | 11 of 13 passed |
| Known-failing | 50 min | 15 of 18 failed as described. The intermittent `cover-crossing-hunt`, `end-crystals-pillar-then-staircase` and `ender-dragon-first-entry` (29 min) passed |

No failing trial lagged. The three failures in the suite:
- **`collect/waterfall-oak`, LiveCollector:** collected no logs in 114 s and
  never returned. This is a new mode of the live stall: 9cbf1b0 fixed five
  logs and then wandering off.
- **`combat/end-crystals-staircase`:** the bot "was doomed to fall by Ender
  Dragon", knocked off the staircase while climbing to the tower at
  -12.5,86,-39.5.
- **`hunt/warped-forest-pearls`:** the hunt's recovery shelter could not close,
  because a protection cell held twisting vines, which placement cannot
  replace. The hunt returned `capability_blocked`. The runtime does not break
  such a plant before walling, which is a runtime gap.

### Confirmation-pass fixes (2026-10-22)

All three suite failures were root-caused and fixed, each with a unit test
that failed first and repeated live passes, no lag.
- **`collect/waterfall-oak`:** two causes.
  - **LiveCollector, 2187ab3:** the pickup approach stopped at the first
    0.02-block overlap of the item, and the waterfall's current pushed the
    body back before the server saw it. The approach now holds on to the item
    with a 0.15 margin until it is taken or one second passes.
  - **NoMaterial, a2cb6c6:** a target refresh inside a running route started
    exploring when only refused logs were left. It now leaves the refusal for
    the mining loop to report.
  - **Proof:** 5 of 5 passed.
- **`combat/end-crystals-staircase`, 9c52111:** the water-bucket fall save
  never poured beside a wall or step. Its forecast refused the whole fall
  when the body's sideways drift touched a block. Each forecast tick now stops
  only the blocked axis, as the client does.
  - **Unit test:** replays the recorded fall onto a step at 15–17,60,26.
  - **Proof:** 7 of 7 passed, with four water saves and none failed.
- **`hunt/warped-forest-pearls`, 6227920:** the shelter now breaks out a
  collisionless plant (vines, sugar cane) in a wall cell before placing the
  wall, under the combat dig permission. With digging prohibited, the refusal
  names the plant.
  - **Proof:** 2 of 2 passed; `combat/wounded-hide` and
    `combat/neutral-bystanders` passed as regression checks.
- **`pathfinder/item-pickup-course`, e91dd24 (found while proving
  waterfall-oak):** a fixture fault. A player joining beside a summoned item
  picked it up before the harness cleared its inventory. Items are now
  summoned once the players stand in their pens.
  - **Proof:** 6 of 6 passed on reused servers.
- **Possible client hang, 70b8936:** a staircase proof trial's client stopped
  answering for 20 s and was timed out. Reading the code turned up a build
  loop that re-ran a step-out route that ended without moving the bot, never
  yielding to the event loop. Two such routes now stop the build with the
  existing "could not step out" refusal.
  - **Unit test:** reproduces the spin.
  - **Not proven:** nothing ties this loop to the freeze. If it recurs, the
    stuck client's stack needs capturing.
- **`combat/creeper-navigation`, Cave, ec65068:** 38 of 40 passed at
  37778b1 (creeper, creeper2); Mixed never fell below 17. The suspected cause, a hold for a recovery
  that never comes, was not it: both failures were already below the bar of
  12 when recovery began. Each took three hits first, two of them from zombie
  #26 while the fight's quarry was skeleton #24. Bow admission checked only
  arrows, so it lowered the shield for a twenty-tick draw with the zombie
  melee-imminent. t00004 was hit at both releases. Across 30 trials the
  zombie hit Cave 12 times, 6 of them mid-draw. A ranged quarry's bow now
  yields to the shielded sword while another walker is imminent, and a draw
  in progress is cancelled when one becomes imminent.
  - **Unit test:** replays the t00004 tunnel scene at 12.91 s.
  - **Proof:** 30 of 30 passed in a row (proof1), no lag, with no zombie
    hit. creeper-reflex, wounded-navigation, wounded-hide and
    navigation-handoff passed once each.
  - **Still open:** the creeper escape turns Cave's back on the skeletons.
    Arrows during the sprint are now its main damage, 16 hits in 30 trials,
    and two of them left one trial at exactly 12. Below the bar,
    recovery is still misjudged, which is a separate gap: the bot cannot see
    `naturalRegeneration false`, so full hunger counts as healing, and it
    hides or evades instead of fighting. In t00004 the evade ran past both
    skeletons and the bot died. In t00007 a stationary guard stopped at 6.

- **`combat/end-crystals-staircase`, perched return, 392012a:** walking
  back across the fountain, the return route stepped up into the perched
  dragon's wing reach. An escape stepped it one block down, and the route
  stepped up again for about 15 s, until the take-off launched the bot to
  y 125 (run 2026-10-21T22-50-17-456Z-t00006). The return now refuses the
  perched head, neck and wing boxes, as the head approach does. When they
  close every route, it holds its clear cell until the perch changes, for
  at most 90 s.
  - **Unit tests:** replay the recorded perch pose and the step from
    -5,63,1 to -5,64,0; a closed return waits instead of stopping.
- **`combat/end-crystals-staircase`, breath jump, 9a9d0d7 (found while
  proving the return):** a fireball cloud on a tread cleared a standing head
  by 0.12 blocks, so navigation admitted the cell, but the step-up into it
  lifted the head into the cloud. The route jumped through it until the bot
  died, six damage a jump (runs 2026-10-22T01-41-26-600Z-t00001 and
  01-47-09-942Z-t00004). Navigation now refuses a jump whose envelope
  enters observed breath deeper than the route's start.
  - **Unit test:** replays the recorded cloud and step-up.
- **Proof for both:** 6 of 6 passed in a row, no lag (`.mine-labs/perch2`,
  2026-10-22T02-09-30-067Z-t00001 to 02-23-31-072Z-t00006).

Still open in `combat/end-crystals-staircase`, both seen once in the
return fix's first session (`.mine-labs/perch`, before the breath-jump fix):
- **Shelter in the strafing band** (2026-10-22T01-41-26-600Z-t00003): the
  bot sheltered high on a staircase (7.6,86,40.5) while the dragon strafed
  at y 85. Each pass's wing knockback hit it through the walls for 1.25, so
  the 90 s hold ended at health 7. The next requests re-entered the same
  shelter, and it died there. The shelter's safety check ignores flying wing
  contact, and `holdWhile` keeps the bot in place while the body passes.
- **Client hang** (2026-10-22T01-41-26-600Z-t00002): after the last crystal
  was destroyed, the client stopped answering and spun one core until the
  2400 s timeout. Bun's inspector cannot pause a spinning thread, so no stack
  was captured. This may be the same freeze as 70b8936.

### Known-failing now

| Fixture | Failure | Pattern | Next |
| --- | --- | --- | --- |
| `collect/cast-obsidian-spawn-column` | Route to the obsidian runs out of its dive breath budget | consistent | Dive budgets on collection routes |
| `combat/basalt-crossfire-wounded` | An evade or hide response cancels the wounded navigate | consistent | Requests resuming after reflex claims |
| `combat/busy-smelt-interrupted` | The cook is cancelled by `[HOSTILE_CONTACT]`, not resumed | consistent | Requests resuming after reflex claims |
| `combat/full-night-request` | A hide response ends the pending hunt's window | consistent | Requests resuming after reflex claims |
| `combat/cover-crossing-hunt` | Shield faces one skeleton while the other swings | about 1 in 10 | Shield arc positioning |
| `combat/skeleton-arena-crossfire` | Arrows from opposite sides within two ticks | intermittent | Shield arc positioning |
| `combat/navigation-side-bridge` | Armour carried, not worn (as the legacy run); loops on an unreachable skeleton | consistent | Navigation under ranged fire |
| `combat/end-crystals-pillar-then-staircase` | Vanilla arrow spread is wider than the slit under the cage; about 40% hits | intermittent, cause proven | Fire from an elevated cell |
| `combat/ender-dragon-first-entry` | Escape blocked by breath in a one-wide pit or tunnel | intermittent (passed once) | Breath escape from narrow cells |
| `combat/ender-dragon-bow` | `shoot_dragon` mostly `[DRAGON_SHOT_BLOCKED]` | consistent | Bow dragon intercepts |
| `drop/disposal-hole-tunnel` | Pit spoil left unreported at the bottom; sometimes picked up again | consistent | Disposal result contract |
| `hunt/basalt-magma-cream-islands` | Jump between islands overshoots into lava; slow return | consistent | Hunt routes over lava |
| `hunt/fortress-rod-and-exit-run14` | Shields wear out; reflex-fight rods left on the ground; slow exit | 1 to 2 of 3 | Fortress blaze hunts |
| `hunt/fortress-spawner-rods` | Shield wear and rate under one rod per minute | consistent | Fortress blaze hunts |
| `pathfinder/flowing-lava-dig-release` | Burns to death after the fire reflex interrupts the route | consistent | Lava and fire escapes |
| `pathfinder/vine-column-handoff` | Lateral step onto a lower column never arrives (partial patch saved) | consistent | Vine column handoff |
| `sleep/bed-exit-after-waking` | No path off the bed after waking | consistent | Pathing off a bed |
| `survival/lava-escapes` (LavaPoolBot) | Two lava hits ten ticks apart kill it unless it reacts at once; regeneration off, as in the legacy fixture | mostly fails | A faster escape strategy |

## Method

1. **Run.** Each legacy fixture ran once, headless, at `fadab1b` on 2026-10-19, using Mine Labs
   `09cbd11`. Runs were grouped by category, used two workers per group and up to four groups at once,
   each on its own port range. End fixtures had no time limit beyond their own. The two `verification/`
   manifests ran with `mine-labs verify`. A fixture that errored inside Mine Labs before its trial began
   was retried on its own.
2. **Classify.** Every fixture's YAML and driver was read. Each was recorded with three fields:
   - **kind**: *action-only* if the driver only requests runtime actions or idles, then checks
     results; *white-box* if it builds its own combat controller, calls navigation or the
     pathfinder directly, imports `src/survival` or `src/navigation` internals, or moves the body
     itself.
   - **verifies**: what its goals and assertions actually check, in one line.
   - **covered by**: any existing `tests/minecraft` fixture that covers it.
3. **Decide.** Each fixture got exactly one fate:
   - **retire-covered**: an existing consolidated fixture already asserts everything it did, by the
     bar commit 2db0f41 used (arrangement, inventory, request, and every goal or driver assertion).
   - **merge**: the behaviour is kept, folded into a named consolidated scenario: one world, related
     behaviours, one request per actor, and goals that fail if any one of them regresses.
   - **migrate**: kept as its own black-box fixture.
   - **unit test**: an incident regression that no black-box scenario can express. The named test
     file either holds the case already ("exists") or gets it ("new").
   - **delete**: with the reason. Used for physical simulations of an internal mechanic that add no
     behavioural guarantee, strict subsets or loadout variants of a kept sibling, diagnostic probes,
     and fixtures whose premise the product has since removed.

## Summary

| Area | Fixtures | pass | fail | timeout | error | not-run | retire-covered | merge | migrate | unit-test | delete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| combat (flat, terrain, default) | 140 | 128 | 11 | 1 | 0 | 0 | 0 | 96 | 1 | 22 | 21 |
| flat/pathfinder | 72 | 70 | 2 | 0 | 0 | 0 | 1 | 48 | 2 | 19 | 2 |
| default/nether | 40 | 18 | 22 | 0 | 0 | 0 | 0 | 29 | 1 | 9 | 1 |
| default/end | 14 | 9 | 1 | 4 | 0 | 0 | 0 | 7 | 5 | 0 | 2 |
| flat work and survival | 123 | 114 | 9 | 0 | 0 | 0 | 0 | 90 | 5 | 16 | 12 |
| everything else | 57 | 48 | 9 | 0 | 0 | 0 | 0 | 29 | 7 | 13 | 8 |
| **total** | **446** | **387** | **54** | **5** | **0** | **0** | **1** | **299** | **21** | **79** | **46** |

Kind: 127 white-box, 319 action-only.

Causes of non-passing runs: 23 stale, 29 behaviour, 4 timeout, 3 harness.

The planned suite has 80 new consolidated or migrated fixtures. Thirteen existing fixtures are
extended; `combat/busy-dig-interrupted` is renamed `combat/busy-work-interrupted`. With the 35
fixtures already there, `tests/minecraft/scenarios/` would hold about 115 fixtures in place of
481 across both catalogues. The `flat/evidence/action-catalog` generator moves out of the test
catalogue (see [Evidence page](#evidence-page)).

Expected runtime: the slowest absorbed fixture in each planned scenario, taken from the legacy
timings, adds up to about 110 minutes in sequence once the two End timeouts are counted at a passing
fight's length. The existing 35 fixtures add about 20 minutes. With two workers, `scenarios:once`
should take an estimated 70 to 90 minutes, against about 10 today. The End (seven fights) and the
Nether hunts account for roughly half of it.

## What the run found

387 of the 446 fixtures passed. The other 59 had four kinds of cause; the full list is in the
ledger's notes column.

- **Stale (23).** The fixture can no longer test what it describes. The commonest cause is that the
  hunt now refuses hostile quarry without a shield (`HUNT_NO_SHIELD`): the fortress, enderman,
  dripleaf and blaze-materials kits carry none. Other causes are drivers parsing result fields the
  runtime no longer reports, recorded generated terrain that no longer matches, and arrangements
  Mine Labs now rejects. Every stale row that is kept is rebuilt with a valid arrangement, for
  example a shield in `players[].equipment` or `allow_without_shield`.
- **Behaviour (29).** The requested outcome failed. The bot died or ended badly hurt:
  - died in the lava-pool step escape;
  - died in lava released during a navigation dig;
  - died on the spreading-lava course;
  - died at the melee lava edge;
  - died during the full-night request;
  - ended a lava-interrupted dig at 1 health.

  Fortress rod rates fell below one per minute, and magma-cream hunts killed dozens of cubes
  without a drop. Disposal holes lost one or two items. These are single runs and may include flakes.
  The scenarios that absorb them must be run before deciding (see
  [Decision needed](#decision-needed)).
- **Harness (3).**
  - Two legacy `survive` goals never settled after a successful completion.
  - One verification location timed out waiting for a server tick under load.
  - One trial errored on an rcon timeout and passed on retry; it is counted as passing.
- **Timeout (4).**
  - All three first-entry fixtures left the dragon alive after 40 minutes. They fight with the
    recorded 2026-09-13 loadout on three seeds.
  - `dragon-bow` left the dragon alive after 20 minutes.

  The other dragon kills passed in 4 to 11 minutes: `ender-dragon`, the post-crystal replay, and
  every crystal method.

None of these legacy failures was being reported, because nothing ran the catalogue.

### Decision needed (resolved)

Resolved on 2026-10-20: failing behaviour went to `tests/minecraft/known-failing/`
(option 2), and each confirmed failure got a proposed fix session. The original
question follows.

Seventeen planned scenarios absorb at least one fixture that failed on behaviour or timed out (the
planned-scenario tables mark them). Two of them are End fights: `combat/ender-dragon-fight` is built
on the first-entry loadout, and `combat/ender-dragon-bow`. Built faithfully, those scenarios will fail. `bun run scenarios:once` has
to pass, so each such case needs one of the following:

1. **Fix the runtime** in the category's migration commit. This widens the migration into
   product work.
2. **Land the scenario outside the green run.** Put it in `tests/minecraft/known-failing/`, which
   `scenarios:once` does not discover, tag it `known-failing`, describe the failure, and propose a
   fix session for each. When fixed, it moves into `scenarios/`.
3. **Drop the failing stage** from the consolidated scenario, which loses the guard.

The recommendation is option 2 for anything still failing after a confirming run, with one fix
session proposed per failure.

## Harness work before the categories

Most consolidated scenarios place several actors in one world. Each actor stands in its own walled
pen, far enough from the others that mobs and tracking cannot cross; each pen runs its own request
and has its own `who`-scoped goals. Mine Labs already starts one client per `players[]` entry, so
this needs no Mine Labs change. The suite's own harness needs these changes, all owned by one person
and landed before the category work:

1. **`drivers/idle.ts`.** Waits `params.waitTicks`, then reports success. World goals carry the
   verdict. About a third of the absorbed rows are idle-reflex cases.
2. **The actor's username on `ScenarioContext`.** Pens need it to find their own request. With it,
   `drivers/action-sequence.ts` accepts `params.players.<username>` alongside the scenario-level
   list.
3. **A per-step `expect` in `action-sequence.ts`,** reusing `single-action`'s expectation schema.
   An optional leading `waitTicks` covers requests made once a fight is under way.
4. **`expect.status` accepting a list in `single-action.ts`.** A hunt asked for more than its pen can
   drop must clear the pen, and kill or distance goals then judge the defeat.
5. **Move `player-preparation.ts` and its test from `scenarios/src/` into `tests/minecraft/`,** since
   `scenario-bot.ts` imports it today.
6. **Document the arrangement idioms for mid-trial events in the README:**
   - run-once `tick` commands guarded by a tag;
   - scoreboard clocks for timed events;
   - `damage … by <player>` to provoke a neutral mob;
   - one-shot `item replace` for worn gear;
   - `effect hunger` for starting hunger.

None of the planned scenarios needs a Mine Labs change. Some optional changes would let fixtures
replace workarounds with plain YAML; each would be a Mine Labs change, so it needs your approval
first:
- a `schedule:` list of one-shot commands;
- `players[].food`;
- a tag or selector on `kill` and `entityCount`;
- item components in equipment;
- an upper bound on `hasItem`.

## Evidence page

`flat/evidence/action-catalog` and `scenarios/src/action-evidence*.ts` make up a documentation
generator, not a test. They call every published MCP tool through the in-memory MCP transport and
write `.mine-labs/evidence/action-evidence.{json,html}`. They assert only that the catalogue is
complete. They move to `tools/action-evidence/` with their own small host. `evidence:render` in
`package.json` and `docker/package.json` will point there, and the catalogue-completeness check
becomes a unit test against `src/actions/catalog.ts`. The other five evidence fixtures map to
existing unit tests, apart from operator capture, which needs a new
`src/server/incident-route.test.ts`.

## Legacy unit tests in `scenarios/src/`

| Test | Fate |
| --- | --- |
| `player-preparation.test.ts` | Moves to `tests/minecraft/` with `player-preparation.ts`. It guards equipment slots, stale inventory counts and dimension-aware settling. |
| `projectile-packets.test.ts` | Deleted with `arrow-position-freshness`, its only user. Arrow flight is pinned by `arrow-flight.test.ts`. |
| `dragon-progress.test.ts` | Deleted. Nothing else imports `DragonDamageProgress`. |
| `ender-dragon.test.ts` | Deleted. It pins the legacy driver's retry loop. A destroyed crystal counting even when the walk back fails becomes a `destroy-end-crystal` action test if no test covers it. |
| `encounter-evidence.test.ts` | Deleted. It tests the legacy drivers' re-parsing of encounter events. |
| `scenario-evidence.test.ts` | Deleted. Black-box drivers do not write files; the host retains evidence when `MINE_AI_SCENARIO_EVIDENCE=1` is set. |

## Planned scenarios

A status of *existing* means the fixture is already in `tests/minecraft` and gains stages or actors.
An absorbed fixture that did not pass in the run carries its verdict in brackets. Design notes for
each scenario are in the triage working notes; this table is the contract.


#### barter

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `barter/ground-first` | existing | Adds the seeded one-gold exchange: exactly one gold spent for the native reward. | seeded-reward |

#### bucket

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `bucket/water-sources-course` | new | Fill water from planted shores, a sealed pocket and a deep pool without a wet stance, then pour, refill and cast obsidian. | fill-planted-shore, fill-planted-shore-approach, fill-sealed-pocket, obsidian-from-deep-water, obsidian-from-lava |

#### build

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `build/enclosures` | new | build_structure finishes a camp roof across stack boundaries and a sealed box from outside, from a start inside each. | roof-gap, sealed-box |

#### collect

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `collect/cast-obsidian` | existing | Gains the two other verified seed-8675309 locations as `verification.locations`. | cast-obsidian (fail) |
| `collect/deep-diamond-descent` | new | Diamonds at the bottom of a 52-block solid hill with zero damage. | deep-diamond-descent |
| `collect/exact-collection-preservation` | existing | Adds the door re-placed while standing in the doorway and a same-state stocked chest that must stay intact. | door-replace-after-pickup, same-state-storage |
| `collect/mixed-resource-site` | existing | Adds an overhead cobweb collected with a sword for string. | cobweb-overhead |
| `collect/mixed-trees` | existing | Adds a loaded oak 70 and 140 blocks out and a canopy climb that ends inspecting a ground chest. | loaded-oak-outside-radius, tree-canopy-chest-handoff |
| `collect/nether-gravel-overhang` | new | Nether gold from the recorded tunnel without stepping onto suspended gravel over lava. | gravel-overhang-mining |
| `collect/netherrack-bank` | existing | Moves into native Nether terrain and keeps the no-physics-gap check from live request 124. | netherrack-loaded-scan (fail) |
| `collect/obsidian-by-exploring` | existing | Raises the count to 3 so the far-lava cast leg is exercised. | obsidian-by-exploring |
| `collect/obsidian-hazards` | existing | Adds a lava-lake ring, a water-covered cast slab and a water plug with no bucket. | obsidian-drain-before-mining, obsidian-lake, obsidian-under-water |
| `collect/obsidian-in-rock` | existing | Adds six level sources collected exactly with no carried blocks and the bucket recovered. | obsidian-six-sources |
| `collect/ocean-sand-shaft` | new | Sand from water above an ocean stronghold (2026-09-11); expected red until the underwater-access fix lands. | ocean-sand-shaft |
| `collect/ore-return-deposit` | new | Iron from a cavern seam and from 11 blocks down, then deposit in the surface chest. | cavern-ore-return, deep-vertical-ore-return |
| `collect/underwater-sand` | new | Sand from a 3-deep seabed with planned breathing, full air and health. | underwater-breathing-stop, underwater-collection |
| `collect/waterfall-oak` | new | Logs beside a waterfall with and without dirt for isolating the flow; partial result when isolation is impossible. | flowing-water-tree, flowing-water-tree-approach, flowing-water-tree-no-material |
| `collect/wet-mining-site` | new | Stone beside water sources, under an aquifer roof, in a stream bed and from a floating stance, staying dry and unhurt. | dry-mining-aquifer-roof, dry-mining-water-wall, preserve-collected-water-plug, stone-from-water, stone-in-flowing-water |

#### combat

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `combat/basalt-crossfire-traverse` | new | Navigate a basalt arena over lava under cubes, ghast and a provoked enderman at 11 health. | basalt-crossfire (fail), basalt-crossfire-provoked (fail) |
| `combat/blaze-fire-idle` | new | An idle bot under native blaze fire survives with sword only or full kit, waits in closed cover, and finishes a blaze with a slow fireball in flight. | closed-cover, distant-attacker, distant-attacker-ranged, persistent-blaze-projectile |
| `combat/bow-range` | new | Bow kills on pinned blazes at 8, 24 and 32 blocks (under a roof slab), raised 4 up, and from a one-block ledge, within six arrows. | bow-after-refused-backstop, bow-close-trajectory, bow-curved-occlusion, bow-elevated-trajectory, bow-flat-24 |
| `combat/busy-work-interrupted` | existing | busy-dig-interrupted renamed; gains a creeper at the mine face and a zombie arriving mid-smelt, each finishing its request. | busy-dig-creeper-interrupted, busy-smelt-interrupted (fail) |
| `combat/cover-fights` | new | Fights from existing cover: blazes from a firing passage, a guarded transit and approach, and skeleton+zombie with fire set in the passage. | blaze-cover-transit-shield, blaze-crossfire-first-hit-shield, blaze-shield-existing-cover, mixed-fight-cover-fire |
| `combat/creeper-navigation` | new | Navigate past creepers in a blocked passage (2026-09-11), cave crossfire, a wounded pocket and with hiding forbidden. | navigation-creeper-blocked-retreat, navigation-creeper-cave-crossfire, navigation-creeper-wounded-pocket, navigation-mixed-creeper-management (fail) |
| `combat/creeper-reflex` | new | Idle creeper encounters with sword, bow pair, stair and bare hands, plus a lit fuse with a husk behind; no blast reaches the bot. | creeper-crowd-live-fuse (fail), idle-creeper-pair-bow-fight, idle-creeper-pair-evade, idle-creeper-stair-fight, idle-creeper-sword-fight, idle-creeper-unarmed-evade |
| `combat/creeper-rocky-crossfire` | new | The 2026-09-12 rocky slope: navigate at 13 health past creeper, spider, zombie and skeleton. | navigation-creeper-rocky-crossfire |
| `combat/dragon-perch-enderman-contact` | new | An angry enderman interrupts a pending perch attack; the bot kills it and the request still settles. | perch-enderman |
| `combat/end-crystals-every-method` | new | All ten crystals destroyed by bow, melee staircase and end-stone-only pillar. | crystals-bow, crystals-melee, crystals-melee-pillar, scaffold-end-stone |
| `combat/ender-dragon-bow` | new | shoot_dragon kills the flying dragon with no crystals left. | dragon-bow (timeout) |
| `combat/ender-dragon-fight` | new | The recorded 2026-09-13 first-entry loadout: mixed crystal clearing, then the perch loop kills the dragon. | claude-first-entry (timeout), crystals-mixed, dragon-perch (fail), ender-dragon |
| `combat/ender-dragon-post-crystal-replay` | new | Seed 64510673 retained death replayed: worn kit, dragon at 190 health, perch loop survives and kills. | dragon-post-crystal-replay |
| `combat/enderman-hunt` | new | Enderman hunts with built, existing and absent roofs, raised quarry, a pair on finite blocks and a close pair; a policy that forbids terrain edits must fail truthfully. | constructed-enderman-roof, ender-pearl, enderman-alcove, enderman-close-pair (fail), enderman-roof-no-approach, enderman-roof-obstructed, enderman-roof-stairs, enderman-shelter-pair |
| `combat/evade` | new | Low-health escapes from zombies, wither skeletons, a blaze corridor, magma cubes over lava and a confined passage beside a bystander. | evade-melee-health, evade-new-contact, fight-yields-when-hurt, hurt-bot-evades, magma-cube-confined-bystander, magma-cube-evade |
| `combat/fireball-deflection` | new | Ghast fireballs returned from a bridge, a fireball deflected mid-navigate, and a blaze fight yielding to a large fireball. | ghast-return-to-sender, incoming-fireball-during-fight, incoming-fireball-navigation |
| `combat/fortress-wounded` | new | Wounded in a fortress: idle under blaze crossfire takes cover, and a withdrawal under pressure reaches the far exit. | fortress-crossfire-cover (fail), fortress-withdrawal (fail) |
| `combat/full-night-request` | new | A pending hunt at 7 health inside a zombie ring survives a full native night and returns. | full-night-request (fail) |
| `combat/idle-melee-reflex` | new | The idle reflex kills zombies with axe, bare hand, sword+shield, a pair and on a step, a spider, and a descending magma cube, and leaves an unreachable ledge zombie alone. | descending-cube-contact, idle-axe-fight, idle-hand-fight, idle-ledge-zombie-evade, idle-lone-zombie-fight, idle-pack-fight, idle-spider-fight, idle-zombie-step-approach |
| `combat/idle-ranged-reflex` | new | The idle reflex kills bow skeletons with and without a bow, from outside contact range, mixed with a zombie, and a phantom. | idle-phantom-fight, idle-skeleton-bow-fight, idle-skeleton-range-fight, idle-skeleton-shield-fight, idle-zombie-skeleton-mixed-fight |
| `combat/knockback-ledge` | new | Idle on a lava shelf or one-wide bridge against an angry enderman (with and without shield), a magma cube and skeleton arrows: no knockback into lava (run 16). | enderman-idle-ledge, enderman-shield-ledge, magma-cube-knockback-platform, skeleton-knockback-bridge |
| `combat/navigation-handoff` | new | One road and a lava shore: navigation hands the body to the reflex for zombies, a pack, a forced corridor, a skeleton, creepers and a returning enderman, and still arrives. | lava-shore, meaningful-wait, navigation-creeper-pair-handoff, navigation-fight-handoff, navigation-four-encounters, navigation-gauntlet-fight, navigation-pack-fight, side-bridge (timeout) |
| `combat/neutral-bystanders` | new | Calm endermen, piglins busy elsewhere, a sunlit spider and an occupied wall cell are left alone; provoked ones are fought and survived. | daylight-spider-ignored, enderman-other-target, hide-close-intruder-neutral, idle-enderman-ignored, idle-enderman-provoked-fight, piglin-attribution, piglin-other-target |
| `combat/night-hostile-haul` | new | One 120-block navigate across steep generated terrain at midnight with spawning on. | night-hostile-haul-20260904 |
| `combat/skeleton-crossfire-navigation` | new | Navigate past skeletons on open ground, on a platform and in a walled arena without taking an arrow. | navigation-skeleton-crossfire (fail), navigation-skeleton-elevated-crossfire, navigation-skeleton-first-shot |
| `combat/withdraw-navigation` | new | defend_only then navigate away from an active blaze or skeleton fight on a lava bridge; a sealed bridge must fail truthfully. | withdraw-navigation, withdraw-navigation-blocked, withdraw-navigation-skeleton |
| `combat/wounded-hide` | new | At 7 health the bot hides and recovers in open ground, on a platform, at night with a spider, with an intruder, sealed in, over a drop, through nether plants and inside a zombie ring. | daylight-spider-at-night, hide-close-intruder (fail), hurt-bot-hides, hurt-bot-walls-in, low-health-night-survival, nether-vegetation-shelter, sealed-in, wall-in-cliff |
| `combat/wounded-navigation` | new | Wounded navigates: the 2026-09-04 stand-down, a supply run keeping its iron, and the 2026-09-09 cave ascent at 2 health. | standing-down, wounded-cave-ascent (fail), wounded-supply-return |
| `combat/wounded-ranged-shelter` | new | At 10 health under blazes or skeletons, with or without blocks, burning or surrounded by soul fire, the bot shelters and recovers to 18. | wounded-blaze-shelter, wounded-burning-shelter, wounded-ranged-unbuildable, wounded-skeleton-shelter, wounded-soul-fire-surround |

#### craft

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `craft/recipe-chains` | new | Ender eyes via powder, recipes with container remainders, and a 16-iron smelt at normal tick rate. | eye-chain, recipe-remainders, smelt-batch-normal |
| `craft/workshop` | existing | Adds the temporary table batch that includes a table, and a failed plan that still recovers its station. | temporary-workstations |

#### drop

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `drop/disposal-holes` | new | Disposal holes from an off-centre stance, in a tunnel and on open ground; a full inventory makes room so a pickup succeeds. | disposal-hole (fail), disposal-hole-offset, disposal-hole-underground (fail), full-inventory-disposal (fail) |

#### explore

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `explore/biome-search` | new | explore_frontier enters a warped forest at feet level, settles a mid-gap entry, and reports an exhausted search truthfully. | biome-entry, biome-exhausted, biome-jump |
| `explore/locate-stronghold` | new | Two cancelled locate calls across a database reopen, then an estimate from saved bearings and the supply refusal. | locate-resume |

#### hunt

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `hunt/awkward-quarry` | new | Hunts reach a cow 54 blocks above a cave, a skeleton above a ceiling, and zombies pinned under or past big dripleaf. | cow-above-cave, dripleaf-pool-pinned (fail), dripleaf-pool-trap (fail), skeleton-above-ceiling |
| `hunt/basalt-magma-cream` | new | Magma cream from small, large, pack and island cubes on generated basalt, returning to the shelf. | generated-basalt-hunt (fail), generated-basalt-hunt-melee (fail), generated-basalt-islands-hunt, generated-basalt-large-cube-hunt, generated-basalt-pack-contact (fail), generated-basalt-pack-hunt (fail) |
| `hunt/blaze-rods` | new | Blaze rods by melee and bow, two blazes, and a bystander zombified piglin that must not be hit. | blaze-bystander, blaze-rod-bow, blaze-rod-single, blaze-rods |
| `hunt/cows-under-mixed-hostiles` | new | Eight beef from fleeing cows over terraces at midnight among zombies, a skeleton and a creeper, with no stuck crouch. | cow-mixed-combat, cow-terrain-controls |
| `hunt/fortress-rod-and-exit` | new | One rod and back to the exit on the bridges, with the upper spawner disabled, and a sortie past a wither skeleton. | fortress-bridge-rod-and-exit (fail), fortress-pair-rod-and-exit (fail), fortress-rod-and-exit (fail), fortress-sortie |
| `hunt/fortress-spawner-rods` | new | Six and twelve rods at the run-14 spawner at one per minute, then twelve eyes of ender. | eyes-of-ender-collection, fortress-expedition-kit (fail), fortress-six-rods-rate (fail), fortress-twelve-rods (fail) |
| `hunt/pasture-sequence` | new | Feathers, sheep, a cow at the contact boundary and a rabbit 65 blocks out; a sealed rabbit is refused truthfully. | chicken-bow-uneven, cow-contact-boundary, rabbit-at-sixty-five, rabbit-behind-fence, two-white-sheep |
| `hunt/skeleton-hunts` | new | Bones with one arrow, and a worn shield that breaks mid-hunt replaced by the spare. | skeleton-bones-limited-ammo, spare-shield |
| `hunt/spawner-camp` | new | camp_spawner returns to the remembered spawner and takes the quarry that appears there. | spawner-camp-quarry |
| `hunt/warped-forest-pearls` | new | Ender pearls in a warped forest at one per minute, on a slope, across a canopy gap, returning home. | canopy-gap-hunt (fail), enderman-nylium-approach, enderman-six-pearls-rate, enderman-six-pearls-slope-rate, enderman-slope-return |
| `hunt/wild-animal-and-receipts` | new | On generated terrain: loaded-mob summary contract, nearest wild animal's drop, and exact eat/place/craft receipts. | loaded-mobs-8675309, settled-counts-8675309, wild-animal-hunt-8675309 |

#### pathfinder

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `pathfinder/basalt-deltas-traverse` | new | Generated basalt gap, magma gap and lower ledge crossed without lava or magma contact. | generated-basalt-gap (fail), generated-basalt-lower_ledge, generated-basalt-magma-gap |
| `pathfinder/bucket-drop-route` | new | Navigate down from an unbreakable 15-block tower through a planned bucket drop. | bucket-drop-route |
| `pathfinder/climbing-course` | new | Twisting, weeping, free-hanging, sprint-entry and ledge-entry vines climbed without a failed step. | twisting-vines-climb, vine-free-hanging, vine-ledge-entry, vine-sprint-entry, weeping-vines-descent |
| `pathfinder/doorway-course` | new | Leave houses and camps by their doors, restore doors across replans, and never dig with dig:false. | camp-door-replan, house-door-exit, no-dig-camp, passage-restoration (fail) |
| `pathfinder/dripstone-stances` | new | From a dripstone tip: navigate out, collect a stone, and refuse a stalactite's support without damage. | dripstone-hanging-support-collect, dripstone-tip-collect, dripstone-wedged |
| `pathfinder/flowing-lava-course` | new | Lava streams to slalom, step beside and jump between, an 80x30 arena of spreading lava, and lava released mid-dig. | lava-advances-during-collection, lava-advances-during-dig (fail), parkour-between-streams, spreading-lava-obstacle-course (fail), step-up-turn-beside-lava-stream, stream-slalom |
| `pathfinder/gauntlet-lava-parkour` | existing | Adds pillar-hop edge landings, a soul-sand lava hop, a momentum step-up corner and a fire lane. | ascending-jump-magma-landing, fire-route, momentum-step-up-corner, short-jump-edge-landing, soul-sand-lava-hop |
| `pathfinder/generated-long-haul` | new | 160 blocks of generated terrain in one navigate into unloaded chunks. | long-haul-terrain |
| `pathfinder/hostile-lane-choice` | new | Routes take the far lane past a zombie or brutes, dig a plug rather than pass, and walk the zombie lane when forced. | brute-corridor-detour, brute-pack-corridor-detour, corridor-detour, corridor-dig, corridor-forced |
| `pathfinder/item-pickup-course` | new | pick_up_items collects drops on ledges, behind walls, rolling and moving, and beside an enderman in the scaffold cell. | item-pickup-area, item-pickup-chase, item-pickup-ledge, moving-item-pursuit, pearl-occupied-scaffold |
| `pathfinder/long-underwater-exit` | new | Two navigates out of an air cavern under a lake by an 80-block dry route without opening water. | long-underwater-exit |
| `pathfinder/movement-course` | existing | Adds an exact-arrival checkpoint and the leaf-hemmed diagonal ascent. | jump-exact-arrival, leaf-hemmed-diagonal-ascent |
| `pathfinder/navigation-refusals` | new | Height-required, spawner, lava-redirecting excavation, stranded platform and climb-out cases refused or completed truthfully. | ground-column-choice, lava-above-excavation, preserve-spawner, stranded-platform-descent, surface-from-cave |
| `pathfinder/scaffold-course` | new | Netherrack and deepslate bridges and pillars, a ledge handoff, a low-ceiling gap and two tower round trips. | netherrack-bridge, parkour-low-ceiling, pillar-short-ledge-handoff, pillar-tower, scaffold-cobbled-deepslate, tower-round-trip-canopy, tower-round-trip-diagonal |
| `pathfinder/underwater-course` | new | Underwater seabed, midwater, current, turn and replan routes; air-limit, blocked and air-pocket targets refused unhurt. | ocean-to-air-pocket, underwater-air-limit, underwater-backstop, underwater-blocked, underwater-current, underwater-descent, underwater-replan (fail), underwater-seabed, underwater-turn |
| `pathfinder/water-course` | new | Surface-water currents, deep corners and falling columns under low ceilings crossed at full health. | shallow-water-surface, water-cross-current, water-cross-current-low-ceiling, water-current-channel, water-deep-corner, water-falling-corner, water-falling-low-ceiling |

#### portal

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `portal/end-portal-course` | new | Activate an End portal and resume after cancel; End entry refused without or far from a bed, allowed near one. | activate-end-and-cross, activate-end-resume, end-entry-distant, end-entry-missing, end-entry-near |
| `portal/nether-round-trip` | new | Build and light a portal from exactly 10 obsidian, refuse a low-supply entry, cross and return. | portal-frame-and-crossing |

#### progression

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `progression/progression-to-diamond` | new | Empty inventory to diamond on seed 8675309 at three verified locations, including three collect-then-craft rounds. | craft-after-collect, progression-to-diamond |
| `progression/tool-tier-progression` | new | Empty inventory to diamond on a flat world with hand, wooden and stone tool tiers proven on coal, iron, copper, clay, dirt and logs. | clay-shore, coal-outcrop, copper-slope, dirt-terrace, fallen-oak, iron-seam, primitive-progression-to-diamond |

#### sleep

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `sleep/bed-lifecycle` | new | Place a carried bed and sleep at night, sleep at a nearby bed, and set respawn by day without sleeping. | carried-bed-night, nearby-bed-day, nearby-bed-night |

#### storage

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `storage/full-inventory-storage` | new | Chest round trip with matching container memory, a blocked chest, and workstations crafted from a full inventory. | chest-round-trip, cramped-chest, full-inventory-workstations |

#### survival

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `survival/breath-reflex` | new | Idle bots in flooded chambers, deep pools, beside a dolphin and under waterfall overhangs surface and refill air. | drowning-beside-dolphin, drowning-bot-surfaces, idle-underwater-survival, shallow-lake, waterfall-low-air-bedrock, waterfall-offset-overhang |
| `survival/bucket-fall-saves` | new | Idle falls of 5, 40 and 80 blocks, onto an edge, into a hole and with the bucket in storage end unhurt with the bucket reclaimed. | bucket-fall-40, bucket-fall-40-edge, bucket-fall-40-hole, bucket-fall-40-storage, bucket-fall-5, bucket-fall-80 |
| `survival/death-recovery` | new | After a death with keepInventory off, pick_up_items recovers at least 90% of a 57-item kit. | death-recovery |
| `survival/dragon-landing-idle-escape` | new | The seed-64510673 idle death: a landing dragon beside a breath cloud is escaped. | landing-idle-escape |
| `survival/eating-reflex` | new | Hungry and wounded idle bots eat carried food unasked and regenerate. | hungry-bot-eats, wounded-bot-eats |
| `survival/end-knockback-water-landing` | new | TNT knocks the bot off a 41-block End platform; it lands in water unhurt and keeps the bucket. | bucket-native-knockback |
| `survival/fire-reflex` | new | Soul fire, lava pockets and lava under soul sand are escaped idle, during a fight and during a navigate or dig. | lava-escape-step (fail), lava-escape-to-water (fail), lava-interrupts-mining (fail), soul-fire-contact, soul-fire-during-fight, soul-fire-request-handoff, soul-fire-sealed-contact, soul-sand-lava-contact |
| `survival/nether-idle-survival` | new | In the Nether at 11 health: idle beside cubes and a cliff, and a lava pool escaped by placing a step. | generated-basalt-wounded, lava-escape-step-nether, wounded-cliff |

#### tools

| Scenario | Status | Guarantees | Absorbs |
| --- | --- | --- | --- |
| `tools/action-evidence/action-catalog` | tool | Not a scenario: the documentation generator behind `evidence:render`, moved out of the test catalogue. | action-catalog (fail) |

## Deletions

46 fixtures are deleted outright.

| Fixture | Reason |
| --- | --- |
| default/end/first-entry-64510673 | seed variant of combat/ender-dragon-first-entry |
| default/end/first-entry-8675309 | seed variant of combat/ender-dragon-first-entry |
| default/hunt/wild-animal-hunt-20260904 | seed variant of hunt/wild-animal-and-receipts |
| default/hunt/wild-animal-hunt-8674349 | seed variant of hunt/wild-animal-and-receipts |
| default/nether/hazards/basalt-crossfire-melee | kit variation of basalt-crossfire; weapon choice is implementation |
| default/observation/loaded-mobs-20260904 | seed variant; see loaded-mobs-8675309 |
| default/observation/loaded-mobs-8674349 | seed variant; see loaded-mobs-8675309 |
| default/receipts/settled-counts-20260904 | seed variant of hunt/wild-animal-and-receipts |
| default/receipts/settled-counts-8674349 | seed variant of hunt/wild-animal-and-receipts |
| default/terrain/night-hostile-haul-8674349 | seed variant of combat/night-hostile-haul |
| default/terrain/night-hostile-haul-8675309 | seed variant of combat/night-hostile-haul |
| flat/bucket/pour-through-lava | Vanilla dependency probe; pourAim is unit-tested and casts are exercised |
| flat/collect/netherrack-loaded-scan-control | Diagnostic control run for default/nether/netherrack-loaded-scan; not a guarantee |
| flat/collect/obsidian-cast-from-far-lava | Subsumed by collect/obsidian-by-exploring's final leg |
| flat/collect/obsidian-in-rock | Stricter single-buried-source case in tests/minecraft obsidian-in-rock |
| flat/combat/angry-enderman-contact | white-box ScenarioCombat target bookkeeping; the black-box outcome (an angry enderman in reach is fought and survived) is the provoked-enderman pen of combat/neutral-bystanders |
| flat/combat/arrow-position-freshness | diagnostic probe with no behavioural assertion |
| flat/combat/blaze-build-materials | obsolete premise: a hostile hunt without a shield is now refused (shield_required) |
| flat/combat/blaze-retreat-shield | max-health-11 shielded variant under blazes at 26; covered by wounded-burning-shelter (shield, 10 health, blazes at 18) |
| flat/combat/bridge-hide | vacuous: the NoAI skeleton never shoots and the fall is 3 blocks, so the goal cannot fail; hurt-bot-walls-in keeps the raised-platform hide |
| flat/combat/constructed-backstop | pins a tactic (backstop construction) and injects velocity |
| flat/combat/distant-attacker-wounded | max-health-11 variant under blazes at 26; wounded-blaze-shelter (10 health, blazes at 18, must recover to 18) is strictly harder |
| flat/combat/elevated-bow-target | same blaze position and loadout as bow-elevated-trajectory |
| flat/combat/elevated-melee-target | white-box ScenarioCombat melee pursuit of a raised blaze; real blaze melee hunts are hunt/blaze-rods and the fortress hunts |
| flat/combat/enderman-build-materials | legacy verdict was inconsistent (driver passed on one death, kill goal wanted both); the no-blocks case is enderman-alcove and the pair case is enderman-shelter-pair |
| flat/combat/enderman-enclosed-shelter | white-box ScenarioCombat from a hand-built sealed shelter: a positioning variation of the roof planner with no extra behavioural guarantee over the enderman-hunt pens |
| flat/combat/enderman-quarry-below-shelter | white-box ScenarioCombat from a hand-built tower: a positioning variation of the roof planner |
| flat/combat/enderman-roof-gaze | existing-roof variant of enderman-roof-no-approach |
| flat/combat/idle-bow-fight | duplicate of idle-skeleton-bow-fight (same loadout, skeleton 12 instead of 7 blocks; idle-skeleton-range-fight keeps the 12-block case) |
| flat/combat/idle-creeper-bow-fight | single-creeper case of idle-creeper-pair-bow-fight, which is strictly harder with the same loadout |
| flat/combat/idle-sword-fight | loadout variant: axe, hand and sword+shield pens already prove weapon fallback against the same zombie |
| flat/combat/incoming-fireball | stationary deflection on a bridge; the ghast pen (stationary, returns real ghast fireballs) and the navigation pen both cover it |
| flat/combat/magma-cube-confined | same passage and cubes as magma-cube-confined-bystander minus the bystander; strict subset |
| flat/combat/mixed-fight-existing-cover | strict subset of mixed-fight-cover-fire (same passage and mobs, without the fire) |
| flat/combat/navigation-creeper-desert-crossfire | open-ground variant of navigation-creeper-cave-crossfire (same mob mix); the cave version is harder |
| flat/combat/navigation-creeper-wall-pocket | full-health variant of navigation-creeper-wounded-pocket (same recess shape and mobs) |
| flat/pathfinder/dripstone-wedged-raw | diagnostic probe of raw_action on an odd stance; no incident; raw-action.test.ts already pins observed-effect semantics |
| flat/pathfinder/parkour-pillar | physically simulates one internal handoff under a hand-built movement policy; without that restriction the bot builds a staircase instead, so no black-box outcome exists |
| flat/survival/bucket-fall-10 | intermediate height between the 5-block (threshold) and 40/80-block falls that are kept |
| flat/survival/bucket-fall-20 | intermediate height between the 5-block (threshold) and 40/80-block falls that are kept |
| flat/survival/bucket-fall-40-impulse | fake client velocity variation; redirect logic pinned by water-landing.test.ts |
| flat/survival/bucket-fall-80-fast | fake client velocity variation, no incident |
| flat/survival/bucket-fall-80-reversal | fake client velocity variation, no incident |
| flat/survival/waterfall-centered-control | control run for waterfall-offset-overhang; the offset case is the incident and is kept |
| flat/water/air-pocket-to-ocean | redundant with kept sibling ocean-to-air-pocket; policy cause pinned by movement-policy.test.ts |
| flat/water/swim-physics | diagnostic control probe, no verdict |

## Unit-test rows

72 fixtures guarded an incident that a colocated unit test already pins; the fixture goes and the
test stays. 7 need a new case, written in the commit that removes the fixture:

| Fixture | New case |
| --- | --- |
| flat/combat/creeper-retreat-interception | src/survival/responses/fight/creeper-retreat.test.ts (new) |
| flat/combat/respawn-metadata | src/actions/view-status/view-status.test.ts (new case: respawn clears own entity metadata) |
| flat/combat/wall-in-cliff-insufficient | src/survival/responses/hide.test.ts (new case: insufficient blocks over a drop fails without extending the footprint) |
| flat/pathfinder/vine-column-handoff | src/navigation/execution/movement-controller.test.ts (new) |
| flat/collect/tool-loss-policy | src/world/tool-loss.test.ts (exists) + src/actions/collect-block/collect-block.test.ts (new) |
| flat/flowing-lava/inherited-stream-turn | src/navigation/execution/movement-controller.test.ts (new) |
| flat/evidence/operator-capture | src/server/incident-route.test.ts (new) |

## Ledger

One row per legacy fixture. *Verdict* is the 2026-10-19 run; *Notes* starts with the run's cause
when it did not pass, then anything the implementer must know.

### flat/combat, flat/combat-terrain, default/combat (140)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| default/combat/enderman-gaze.yaml | pass | white-box | A directly attached gaze guard prevents provoking an End enderman for 40 looked-at ticks; an unguarded look then provokes it |  | unit test: src/survival/guards/enderman-gaze.test.ts (exists: End eye contact is diverted...; gaze guard respects dimension, cover, pumpkin...) | Driver controls the look itself; the positive control only re-proves vanilla. |
| flat/combat-terrain/enderman-idle-ledge.yaml | pass | action-only | Unshielded idle bot at the east edge of a 3x3 shelf over lava, attacked by an angry enderman arriving west, survives without entering lava (min y 47, grounded) |  | merge → `combat/knockback-ledge` | Run 16 death, incident 1379b59d (2026-09-08/09), postmortem in enderman-idle-ledge.md and reports/enderman-ledge-postmortem. Arrangement used chat teleport + AngryAt from the live UUID: spawn the enderman at the arrival point with AngryAt from the precomputed offline UUID (deterministic from the player name) or a tick damage-by-player. edgeContacts>0 is a stimulus check, diagnostic only. |
| flat/combat-terrain/enderman-shield-ledge.yaml | pass | action-only | Same shelf and enderman with a shield carried: survives, no lava, stays on the shelf |  | merge → `combat/knockback-ledge` | Second actor of the same arena. |
| flat/combat-terrain/lava-shore.yaml | pass | action-only | navigate from the last dry row of a lava shore to (-12,-60,-4) while two zombies attack: route succeeds, arrives, never in lava, alive |  | merge → `combat/navigation-handoff` | Leg of the navigation-handoff sequence; goals reach + survive + health threshold (regen off stands in for never-in-lava). |
| flat/combat-terrain/magma-cube-knockback-platform.yaml | pass | action-only | Idle bot at the shelf edge over lava survives a large magma cube jumping in from the west without entering lava |  | merge → `combat/knockback-ledge` | Same arena as the enderman shelf. |
| flat/combat-terrain/side-bridge.yaml | timeout | action-only | navigate across a two-wide bridge over lava while a skeleton fires from a fenced side platform; arrives at the far bank alive, never in lava |  | merge → `combat/navigation-handoff` | Run: behaviour: never reached the far bank within 125 s under skeleton fire. Leg of the navigation-handoff sequence. |
| flat/combat-terrain/skeleton-knockback-bridge.yaml | pass | action-only | Idle unshielded bot on a one-wide bridge over lava survives skeleton arrows from 8 blocks west without being pushed into lava |  | merge → `combat/knockback-ledge` | Also keeps constructed-backstop's outcome. |
| flat/combat/angry-enderman-contact.yaml | pass | white-box | While a ScenarioCombat engagement holds a NoAI zombie as its target, the first hit the bot lands is on a gaze-provoked enderman in reach, and health stays >=12 |  | delete: white-box ScenarioCombat target bookkeeping; the black-box outcome (an angry enderman in reach is fought and survived) is the provoked-enderman pen of combat/neutral-bystanders | Black-box: collect_mob_drop zombie/rotten_flesh with the enderman provoked by a one-shot tagged tick command (damage ... minecraft:player_attack by ContactFighter) instead of the driver staring at it; armor via players[].equipment; goals survive + health>=12 (regen off). First-hit-on-enderman is a tactic, drop it. Random zombie loot needs the expect-status list (see .md gaps). |
| flat/combat/arrow-position-freshness.yaml | pass | white-box | Diagnostic only: >=2 skeleton arrows, >=1 shield block and a written incident capture; its own comment says success is not correctness |  | delete: diagnostic probe with no behavioural assertion | Driver raises the shield itself and summons the skeleton. Arrow packet/flight reconciliation is pinned by src/survival/perception/combat/arrow-flight.test.ts (exists). |
| flat/combat/blaze-build-materials.yaml | fail | action-only | Hunt with only a diamond sword defeats one of two blazes 20 blocks either side and survives (kill goal wants both dead) |  | delete: obsolete premise: a hostile hunt without a shield is now refused (shield_required) | Run: stale: HUNT_NO_SHIELD: the fixture carries no shield. Carries no shield, so collect_mob_drop refuses before moving; the fixture can no longer exercise what it describes. Refusal pinned by src/actions/hunt-mob/shield-gate.test.ts. If a no-blocks blaze defeat is wanted, add an open-ground pen with a shield to combat/blaze-hunt-cover. |
| flat/combat/blaze-cover-transit-shield.yaml | pass | white-box | During a ScenarioCombat pursuit out of a stone alcove, a fireball summoned along the passage on the first navigation step causes no damage and no burning (min health 20) |  | merge → `combat/cover-fights` | Dated incident: 2026-09-08 spawner death (cover/navigation handoff). The step-timed fireball injection is not expressible; black-box pen keeps the alcove with an AI blaze beyond its mouth and asks the hunt; goal health>=N with regen off so an exposed transit shows as damage. Guard timing units: controller.blaze-cover.test.ts. |
| flat/combat/blaze-crossfire-first-hit-shield.yaml | pass | white-box | Crossing open ground toward a pinned blaze, the shield is raised before the first sword wither-skeleton hit lands (or no hit lands at all) |  | merge → `combat/cover-fights` | Black-box pen: unarmoured, regen off, pinned blaze 32 blocks out, two AI sword wither skeletons astride the route; goal survive + health threshold (a lost guard shows as damage plus wither). The before-the-swing decision is pinned by src/survival/perception/combat/melee-imminence.test.ts (exists). |
| flat/combat/blaze-retreat-shield.yaml | pass | action-only | Idle armored bot with sword+shield at max health 11 survives 20 s of native blaze fire from 26 blocks |  | delete: max-health-11 shielded variant under blazes at 26; covered by wounded-burning-shelter (shield, 10 health, blazes at 18) | Driver equips armor/shield itself (use players[].equipment) and sets max_health 11 by /attribute (tick command, or players[].health 11 with regen off). Description promises no hit but only survival is asserted; add a health goal to make that real. |
| flat/combat/blaze-shield-existing-cover.yaml | pass | white-box | ScenarioCombat kills both AI blazes from a prebuilt two-cell firing passage, then legacy navigation reaches the exit (0,-60,-4); bot alive |  | merge → `combat/cover-fights` | Black-box: action-sequence [collect_mob_drop blaze, navigate exit]; goals kill blaze, reach exit, survive. Needs per-step expect for the random-loot hunt. Existing-cover tactics pinned in controller.blaze-cover.test.ts. |
| flat/combat/bow-after-refused-backstop.yaml | pass | white-box | On a one-block ledge with shield+bow+arrows and nothing to build with, combat kills a pinned blaze 14 blocks away within 10 s |  | merge → `combat/bow-range` | Ledge pen. Shield released before the draw is pinned by src/survival/weapons/item-use.test.ts (exists: drawing a bow releases server shield use...). |
| flat/combat/bow-close-trajectory.yaml | pass | white-box | ScenarioCombat with bow+shield kills a pinned equal-height blaze 8 blocks away within six arrows and releases controls |  | merge → `combat/bow-range` | Pen goal: blaze dead and hasItem arrow >=58 of 64 (six-shot budget). Description text is copy-pasted from bow-flat-24. |
| flat/combat/bow-curved-occlusion.yaml | pass | white-box | Kills a pinned blaze 32 blocks away beneath a stone roof slab (x 6..18, y -58) within six arrows; clearance flag is logged but not part of the verdict |  | merge → `combat/bow-range` | Pen keeps the roof slab; arrows >=58 is the budget witness. Curved-launch math pinned by src/survival/weapons/bow-trajectory.test.ts. |
| flat/combat/bow-elevated-trajectory.yaml | pass | white-box | Kills a pinned blaze 3 blocks away and 4 blocks up with bow+shield within six arrows |  | merge → `combat/bow-range` | Same geometry as elevated-bow-target: one pen. |
| flat/combat/bow-flat-24.yaml | pass | white-box | Kills a pinned equal-height blaze 24 blocks away within six arrows |  | merge → `combat/bow-range` | Unit: controller.test.ts (a distant equal-height bow release uses the compensated launch direction). |
| flat/combat/bridge-hide.yaml | pass | action-only | 7-hp idle bot on a one-wide nether-brick bridge beside a pinned skeleton survives 120 s |  | delete: vacuous: the NoAI skeleton never shoots and the fall is 3 blocks, so the goal cannot fail; hurt-bot-walls-in keeps the raised-platform hide | Dated incident: run 14, 2026-09-07 fortress walkway (first wall refused, fireball knocked bot 22 blocks). hurtTo -> players[].health 7. The pinned skeleton never shoots and the fall is only 3 blocks, so survival is weak: add reach(bridge, radius 1.5). |
| flat/combat/busy-dig-creeper-interrupted.yaml | pass | action-only | collect_block 28 stone succeeds while a creeper walks up from behind; 28 cobblestone, health>=15, no explosion (driver counter) | tests/minecraft/scenarios/combat/busy-dig-interrupted.yaml (zombie variant only) | merge → `combat/busy-work-interrupted` | Add a second actor with the identical collect_block request in its own pen (face 3 blocks nearer, creeper at -9.5, no shield); per-who hasItem 28 + health>=15; blocksAt on the pen floor behind the bot replaces the explosion counter. |
| flat/combat/busy-smelt-interrupted.yaml | fail | action-only | smelt_item 3 raw_iron at a placed furnace yields 3 iron_ingot while a zombie arrives mid-cook; survives; furnace window closed after |  | merge → `combat/busy-work-interrupted` | Run: behaviour: the cook was cancelled by HOSTILE_CONTACT and not resumed; 3 ingots never produced. single-action smelt_item with expect interruptionContains [HOSTILE_CONTACT] like busy-dig-interrupted. The window-closed check has no black-box witness; drop it (smelt contract tests own it). |
| flat/combat/chicken-bow-obstructed.yaml | pass | white-box | Engaging a NoAI chicken behind a grass ledge, no arrow is released toward obstructing terrain before a hit lands; health 20 |  | unit test: src/survival/control/combat/controller.test.ts (exists: terrain obstructing a bow at draw tick N cancels without release and approaches) | Pins a tactic (no arrow into terrain); a chicken hunt outcome adds nothing a unit test does not. |
| flat/combat/closed-cover.yaml | pass | action-only | Idle bot sealed in a 1x1 nether-brick cell with a NoAI blaze 5 blocks out stays put at health 20 with walls intact for 660 ticks, then kills the blaze once the fixture opens one wall |  | merge → `combat/blaze-fire-idle` | Open the wall at tick 660 with a scoreboard tick timer. Per-pen goals: health 20, blocksAt remaining walls+roof nether_bricks, entityDistance blaze clear for that player. Replaces the 30 s hide-cooldown regression. |
| flat/combat/combat-late-knockback.yaml | pass | white-box | Knockback velocity injected on the item-release tick beside lava leaves the bot grounded, out of lava, health 20 |  | unit test: src/survival/weapons/item-use.test.ts (exists: cleanup settles the body after the final item-release tick can deliver knockback) | Physical replay of CombatItemUse.neutralise + SupportedPositionHold. |
| flat/combat/constructed-backstop.yaml | pass | white-box | Combat builds a two-high backstop on a one-wide bridge over lava, then an injected knockback leaves the bot on the deck at health 20 |  | delete: pins a tactic (backstop construction) and injects velocity | The outcome (not knocked off a one-wide bridge over lava) stays in combat/knockback-ledge's skeleton-bridge pen; hold correction in src/navigation/steering/supported-position.test.ts. |
| flat/combat/constructed-enderman-roof.yaml | pass | action-only | collect_mob_drop enderman on open ground with 16 cobblestone and iron armor kills the enderman; survives |  | merge → `combat/enderman-hunt` | Defeat-only (defeat_count 1); random pearl loot needs the expect-status list or omit completion. |
| flat/combat/creeper-crowd-live-fuse.yaml | fail | white-box | retreatFromCreepers from a lit creeper 2 blocks away with a NoAI husk behind ends >8 blocks clear, fuse unwound, health 20 |  | merge → `combat/creeper-reflex` | Run: stale: retreat ended 16 blocks clear at full health; the driver's validity check rejected the arrangement. Black-box pen: creeper {Fuse:30,ignited:1b} 2 blocks east, NoAI husk 1 block west, unarmed idle bot; goals health 20 (regen off) + blocksAt floor (no crater). |
| flat/combat/creeper-crowd-retreat.yaml | pass | white-box | retreatFromCreepers never closes on a NoAI creeper when a NoAI husk stands behind (8 ticks) |  | unit test: src/survival/control/combat/controller.creeper.test.ts (exists: a nearby melee crowd cannot turn a creeper retreat toward the fuse) | NoAI creeper never fuses, so this is pure steering. |
| flat/combat/creeper-retreat-interception.yaml | pass | white-box | A husk teleported into an already committed creeper escape line is steered around (>=1.1 blocks) without closing on the fuse |  | unit test: src/survival/responses/fight/creeper-retreat.test.ts (new) | Playthrough regression: escaping a fuse must not freeze crowd awareness. No colocated test re-evaluates the crowd mid-escape. |
| flat/combat/daylight-spider-at-night.yaml | pass | action-only | 7-hp idle bot with a NoAI spider at midnight recovers to >=12 health and survives |  | merge → `combat/wounded-hide` | Positive control for daylight-spider-ignored (2026-09-04). players[].health 7. |
| flat/combat/daylight-spider-ignored.yaml | pass | action-only | 7-hp idle bot at noon with a NoAI spider in full sky light does nothing: spider alive, 16 cobblestone kept, survives |  | merge → `combat/neutral-bystanders` | Dated incident 2026-09-04 (hid all morning from a sunlit spider). Rule pinned by threats.test.ts (a spider in daylight is left alone...). Needs a noon world: roof the other neutral pens. |
| flat/combat/descending-cube-contact.yaml | pass | action-only | Idle armored bot survives a size-3 magma cube released from 6 blocks overhead, and the large cube dies |  | merge → `combat/idle-melee-reflex` | Driver hooks createCombatController only to count a diagnostic guard. Release after 20 ticks by scoreboard timer (or summon without NoGravity). Large-cube death is not separable from split cubes in goals: use survive + health threshold. |
| flat/combat/direct-hunt-scaffold-resource-progress.yaml | pass | action-only | Async submit/wait of collect_mob_drop for an unreachable elevated zombie reports scaffoldPlaced in each wait and in settled progress equal to native placements; ends failed targets_unreachable with a safe handoff |  | unit test: src/session/progress.test.ts (exists: combatResources incl. scaffoldPlaced; each waiter sees only changes since its baseline) | Exercises the async submit/wait protocol the new suite deliberately excludes. Optional black-box remainder (expect failed, targets_unreachable) belongs under hunt/, not combat. |
| flat/combat/distant-attacker-ranged.yaml | pass | action-only | Idle armored bot with bow, sword and shield survives 20 s of native blaze fire from 26 blocks |  | merge → `combat/blaze-fire-idle` | Description says without losing health; add health 20 for this pen. Detection before damage beyond observation range is pinned by hostile.test.ts (exists). |
| flat/combat/distant-attacker-wounded.yaml | pass | action-only | Same loadout at max health 11 survives 20 s of blaze fire from 26 blocks |  | delete: max-health-11 variant under blazes at 26; wounded-blaze-shelter (10 health, blazes at 18, must recover to 18) is strictly harder | max_health 11 via tick /attribute or players[].health 11 with regen off. |
| flat/combat/distant-attacker.yaml | pass | action-only | Idle bot with only a sword survives 20 s of native blaze fire from 26 blocks |  | merge → `combat/blaze-fire-idle` | Blaze is summoned by the driver at start; Mine Labs entities give the same timing. |
| flat/combat/elevated-bow-target.yaml | pass | white-box | ScenarioCombat lands a hit on a pinned blaze 3 blocks away and 4 up (shield, sword, bow) and releases controls |  | delete: same blaze position and loadout as bow-elevated-trajectory | Same pen as bow-elevated-trajectory; give that actor the sword too (kill is the outcome, weapon choice is not). |
| flat/combat/elevated-melee-target.yaml | pass | white-box | Pursuit on existing ground lands a melee hit on a pinned blaze 2 blocks up and 8 away (sword+shield) and releases controls |  | delete: white-box ScenarioCombat melee pursuit of a raised blaze; real blaze melee hunts are hunt/blaze-rods and the fortress hunts | Melee-only pen in the stationary-blaze arena; goal blaze dead + health 20. Unit: controller.test.ts elevated-target tests. |
| flat/combat/enderman-alcove.yaml | pass | action-only | Hunt kills an enderman beside a narrow two-high stone alcove with no blocks carried; survives |  | merge → `combat/enderman-hunt` | Defeat-only. |
| flat/combat/enderman-build-materials.yaml | fail | action-only | Hunt with sword+shield and no blocks (regen off) defeats an enderman of a pair 20 blocks either side within 30 s; kill goal needs both dead; survives |  | delete: legacy verdict was inconsistent (driver passed on one death, kill goal wanted both); the no-blocks case is enderman-alcove and the pair case is enderman-shelter-pair | Run: behaviour: hunt failed with a COMBAT error and no enderman died. Legacy driver passes on one death while the kill goal wants both; pick one in the merged pen (both dead). |
| flat/combat/enderman-close-pair.yaml | fail | action-only | Hunt against a close native enderman pair kills at least one and keeps minimum health >=12 (diamond armor, 17 netherrack, beef) |  | merge → `combat/enderman-hunt` | Run: stale: HUNT_NO_SHIELD: the kit carries no shield. Minimum health is driver-sampled; with regen off a final health>=12 goal approximates it (legacy world had regen on). Decision hook is diagnostic only. |
| flat/combat/enderman-enclosed-shelter.yaml | pass | white-box | ScenarioCombat kills a player-provoked enderman from inside a sealed 1x1 cobblestone shelter (pickaxe, 64 cobble) and survives |  | delete: white-box ScenarioCombat from a hand-built sealed shelter: a positioning variation of the roof planner with no extra behavioural guarantee over the enderman-hunt pens | Black-box: hunt request; provoke with a one-shot tagged tick command damage-by-player. |
| flat/combat/enderman-other-target.yaml | pass | action-only | Idle pumpkin-headed bot neither attacks nor is hurt by an enderman angry at a 200-hp NoAI zombie for 80 ticks |  | merge → `combat/neutral-bystanders` | Attack counter is a monkeypatch; black-box goals health 20 + entityCount enderman min 1 + zombie min 1. Provocation by scoreboard-timed damage-by-zombie tick command; pen must be roofed if the world is noon. Unit: threats.test.ts (enderman angry at an unknown victim never authorizes attack). |
| flat/combat/enderman-quarry-below-shelter.yaml | pass | white-box | ScenarioCombat kills a provoked enderman on the ground beneath the bot's 5-high stone tower and capped roof; survives |  | delete: white-box ScenarioCombat from a hand-built tower: a positioning variation of the roof planner | Black-box: hunt request; provoke by tick command. |
| flat/combat/enderman-roof-gaze.yaml | pass | action-only | Hunt kills an enderman standing one block raised, with an existing roof and 32 cobblestone; survives |  | delete: existing-roof variant of enderman-roof-no-approach | Defeat-only. |
| flat/combat/enderman-roof-no-approach.yaml | pass | action-only | Hunt starting under an existing roof (64 cobble, no armor) kills an enderman 6 blocks away; survives |  | merge → `combat/enderman-hunt` | Defeat-only. |
| flat/combat/enderman-roof-obstructed.yaml | pass | action-only | With survival policy dig/place disabled, a hunt for two endermen sealed in a cobblestone box returns non-success, changes no block, and the bot survives |  | merge → `combat/enderman-hunt` | Request is [set_survival_policy terrain dig/place false, collect_mob_drop expecting failure]: needs action-sequence with per-step expect. blocksAt over the shell and the roof replace the blockUpdate counter. Truthful-refusal + explicit-prohibition contract. |
| flat/combat/enderman-roof-stairs.yaml | pass | action-only | Hunt kills exactly one AI enderman raised on a stone stair (64 cobble, armor) with minimum health >=10 |  | merge → `combat/enderman-hunt` | CombatPosition.planRoof and the decision hook are diagnostics only. Regen off so a final health>=10 goal stands in for the minimum. |
| flat/combat/enderman-shelter-pair.yaml | pass | white-box | Two sequential ScenarioCombat engagements kill two endermen with only 11 cobblestone (one shelter's worth); survives |  | merge → `combat/enderman-hunt` | Black-box: hunt must continue past the first pearl; needs count above possible drops + expect-status list. |
| flat/combat/evade-fireball-crossing.yaml | pass | white-box | A directly executed evade at 11 hp meets a summoned fireball crossing its next cells and ends safe_separation with health unchanged |  | unit test: src/survival/perception/combat/shield-projectiles.test.ts (exists: a retreat warning includes a crossing shot before it intersects the stationary body) | Replay of fortress shot 427. |
| flat/combat/evade-gap-impulse.yaml | pass | white-box | Emergency evade on a bridge with a four-block gap does not take the parkour jump (an injected velocity during any jump would drop it); stays at y>=-56, health 11 |  | unit test: src/survival/reflexes/hostile.test.ts (exists: an emergency retreat excludes momentum-dependent parkour while preserving supported movement) | Fortress retreat incident (trace 1788830713502). |
| flat/combat/evade-melee-health.yaml | pass | action-only | 11-hp iron-armored idle bot survives 20 s of two sword wither skeletons released at contact range on nether bricks |  | merge → `combat/evade` | hurt() -> players[].health 11; NoAI release at start is what Mine Labs entities already do. |
| flat/combat/evade-new-contact.yaml | pass | action-only | 11-hp idle bot with only a shield survives 20 s of two blazes at either end of a bedrock corridor |  | merge → `combat/evade` | Legacy world is noon; midnight is equivalent for blazes. New-contact recording is pinned by hostile.test.ts (one evade retains its first threat and records a new contact). |
| flat/combat/fight-yields-when-hurt.yaml | pass | action-only | Unarmed bot engaging two zombies, dropped to 11 hp after 20 ticks, survives 60 s |  | merge → `combat/evade` | Regen on in legacy (food heals). Mid-fight /damage at tick 20 via scoreboard timer. Only survival is asserted. |
| flat/combat/fireball-arrival-priority.yaml | pass | white-box | guardRetreatProjectiles, called directly behind a raised shield, blocks a fast far fireball and a slow near one from opposite bearings at health 20 |  | unit test: src/survival/perception/combat/shield-projectiles.test.ts (exists: a newly spawned closer fireball does not turn the shield away from the faster arriving shot) | Physical replay of crossfire ordering. |
| flat/combat/full-night-request.yaml | fail | action-only | A pending collect_mob_drop for absent cows (observe 550 s) at 7 hp inside a ring of 8 zombies and a spider survives a full native night and returns exactly once, not cancelled |  | migrate → `combat/full-night-request` | Run: behaviour: the bot died during the night. single-action collect_mob_drop {cow, leather, observe_for_ms 550000} expect failed (observation_exhausted); players[].health 7; world time 13000; survive 550. Dawn/world-tick check is not expressible (observe window bounds it). 11-minute trial: tag reliability and keep out of scenarios:once if too slow. |
| flat/combat/ghast-return-to-sender.yaml | pass | action-only | Idle sword bot on a one-wide netherrack bridge returns a pinned ghast's fireball, kills the ghast, stays put at health 20 |  | merge → `combat/fireball-deflection` | Goals: health 20, ghast dead, reach origin radius 0.5; tick tp keeps the ghast pinned. Ghast follow range is 64+: give it the most isolated pen. |
| flat/combat/hidden-blaze-dig-approach.yaml | pass | white-box | ScenarioCombat finishes an approach dig toward a charged blaze hidden behind netherrack and kills it |  | unit test: src/survival/control/combat/controller.test.ts (exists: a hidden charged blaze lets an excavation turn finish, but ... still interrupts) | Run 16 incident d66040d1. The charged-while-hidden precondition needs teleports mid-trial; not reproducible black-box. |
| flat/combat/hide-close-intruder-neutral.yaml | pass | white-box | hideInPlace at <=8 hp never attacks a NoAI piglin occupying a wall cell and reports the overlap instead |  | merge → `combat/neutral-bystanders` | Black-box needs a hostile in sight to trigger hide (pinned skeleton) and IsImmuneToZombification:1b on the piglin (overworld). Goals: piglin entityCount min 1, survive. Unit: hide.test.ts (exists: a neutral piglin sharing the construction space is not permission to attack). |
| flat/combat/hide-close-intruder.yaml | fail | white-box | hideInPlace at <=8 hp attacks an adjacent sword wither skeleton before closing the shelter |  | merge → `combat/wounded-hide` | Run: behaviour: walled in but never struck the intruder; hold exhausted at 10.4 health, 18 required. Black-box pen: 8 hp, AI wither skeleton adjacent; goals survive + health recovered. Unit: hide.test.ts (exists: hide repels an authorized intruder before building). |
| flat/combat/hide-from-cell-edge.yaml | pass | white-box | hideInPlace from a start straddling the footing cell edge (0.12, 0.88) digs to y<=-63 and closes a dirt shell; health 20 |  | unit test: src/survival/responses/hide.test.ts (exists: wall centering cases) | white-box hideInPlace from a fractional start; the run-12 centring incident is pinned by the hide centring tests; Run 12 incident. Black-box pen: same start coords, health 7, a pinned hostile in sight, nothing carried (hand dig); goal survive + health>=12. |
| flat/combat/hurt-bot-evades.yaml | pass | action-only | 8-hp idle bot with sword+shield survives two zombies arriving from 24 blocks |  | merge → `combat/evade` | players[].health 8; regen off. |
| flat/combat/hurt-bot-hides.yaml | pass | action-only | 7-hp idle bot in open ground with a skeleton and two zombies recovers to >=12 health and survives |  | merge → `combat/wounded-hide` | First-playthrough death shape. |
| flat/combat/hurt-bot-walls-in.yaml | pass | action-only | 7-hp bot on a platform 4 above ground (digging would drop it) recovers to >=12 health and survives |  | merge → `combat/wounded-hide` | Third-playthrough death (hide refused to dig over air). |
| flat/combat/idle-axe-fight.yaml | pass | action-only | Idle bot with axe, shovel and pickaxe kills a zombie arriving from 24 blocks and survives |  | merge → `combat/idle-melee-reflex` | Per-pen kill witness: entityDistance zombie clear + reach pen centre for that player. |
| flat/combat/idle-bow-fight.yaml | pass | action-only | Idle bot with bow, sword and shield kills a skeleton 12 blocks away and survives |  | delete: duplicate of idle-skeleton-bow-fight (same loadout, skeleton 12 instead of 7 blocks; idle-skeleton-range-fight keeps the 12-block case) | Bow selection is diagnostic; kill + survive are the goals. |
| flat/combat/idle-creeper-bow-fight.yaml | pass | action-only | Iron-armored idle bot with bow+sword kills a creeper from 12 blocks with health>=15 |  | delete: single-creeper case of idle-creeper-pair-bow-fight, which is strictly harder with the same loadout | wearArmor -> players[].equipment. |
| flat/combat/idle-creeper-pair-bow-fight.yaml | pass | action-only | Iron-armored idle bot with bow+sword kills two creepers from 14 blocks with health>=15 |  | merge → `combat/creeper-reflex` |  |
| flat/combat/idle-creeper-pair-evade.yaml | pass | action-only | Iron-armored sword-only idle bot takes no damage (health 20) from two approaching creepers |  | merge → `combat/creeper-reflex` | Live incident: a fought pair took the bot 18 -> 11 -> 4. |
| flat/combat/idle-creeper-stair-fight.yaml | pass | action-only | Iron-armored sword bot with a creeper inside contact range and a staircase behind it kills the creeper with health>=15 |  | merge → `combat/creeper-reflex` | Hillside double-explosion incident; keep the staircase geometry in the pen. |
| flat/combat/idle-creeper-sword-fight.yaml | pass | action-only | Iron-armored sword bot kills one creeper from 12 blocks with health>=15 |  | merge → `combat/creeper-reflex` |  |
| flat/combat/idle-creeper-unarmed-evade.yaml | pass | action-only | Bare-handed idle bot takes no damage (health 20) from one approaching creeper |  | merge → `combat/creeper-reflex` |  |
| flat/combat/idle-enderman-ignored.yaml | pass | action-only | An idle bot with sword+shield leaves an unprovoked enderman 5 blocks away alone: enderman alive, bot at 20 health after 300 ticks. |  | merge → `combat/neutral-bystanders` | Pen EnderCalm. Goals: health 20 (who EnderCalm) is the strong check; entityCount enderman min 1 is weak once a second (provoked) enderman shares the fixture. Comment: treating it as a threat cost a mining trip its iron. |
| flat/combat/idle-enderman-provoked-fight.yaml | pass | action-only | An armored idle bot survives an enderman it provoked with a player_attack /damage from itself. |  | merge → `combat/neutral-bystanders` | Pen EnderAngry. Provocation needs no op: tick command run-once via tag, e.g. execute as @a[name=EnderAngry,tag=!provoked] at @s run damage @e[type=enderman,limit=1,sort=nearest] 1 minecraft:player_attack by @s; then tag add provoked. Armor via players[].equipment. |
| flat/combat/idle-hand-fight.yaml | pass | action-only | With armor and shield but no weapon, the idle reflex kills a zombie walking in from 24 blocks and survives. |  | merge → `combat/idle-melee-reflex` | Pen Hand (unarmed loadout variant). Armor+shield via equipment. Goal kill zombie (global), survive. |
| flat/combat/idle-ledge-zombie-evade.yaml | pass | action-only | A zombie on an unreachable walled ledge is left alone: zombie alive, bot still at its start cell (r 0.5) with 20 health. |  | merge → `combat/idle-melee-reflex` | Pen Ledge. The fixture's global kill-zombie goal would contradict this zombie surviving: put a husk on the ledge instead and assert entityCount husk min 1 max 1, reach start r 0.5, health 20. |
| flat/combat/idle-lone-zombie-fight.yaml | pass | action-only | With sword+shield the idle reflex kills a zombie approaching from 24 blocks without taking any damage (health 20). | combat/busy-dig-interrupted (partly: contact interrupts an action, no kill/health check) | merge → `combat/idle-melee-reflex` | Pen LoneZombie. Keep health 20 goal (shielded melee takes no damage). |
| flat/combat/idle-pack-fight.yaml | pass | action-only | An armored idle bot kills both of two abreast zombies and survives. |  | merge → `combat/idle-melee-reflex` | Pen Pack. Armor in equipment keeps one kill's cost clear of the 10-health fight threshold (comment). |
| flat/combat/idle-phantom-fight.yaml | pass | action-only | An armored idle bot kills a phantom (a flier typed mob, unreachable by ground route) and keeps at least 10 health. |  | merge → `combat/idle-ranged-reflex` | Pen Phantom. Goals entityCount phantom max 0, health 10. Pens must be roofless; phantom must not reach other pens (separate by >64 blocks). |
| flat/combat/idle-skeleton-bow-fight.yaml | pass | action-only | An armored idle bot with bow+arrows kills a bow skeleton 7 blocks away without taking damage (health 20). |  | merge → `combat/idle-ranged-reflex` | Pen SkeletonBow. finishAfterTargetDeath param only shortened the wait. |
| flat/combat/idle-skeleton-range-fight.yaml | pass | action-only | A skeleton holding at 12 blocks (outside contact range) that shoots the bot is recognised via damage as contact and killed; bot keeps >=10 health. |  | merge → `combat/idle-ranged-reflex` | Pen SkeletonRange. Pen walls must not block line of sight between bot and its skeleton. |
| flat/combat/idle-skeleton-shield-fight.yaml | pass | action-only | An armored idle bot with sword+shield (no bow) kills a bow skeleton 7 blocks away and keeps >=10 health. |  | merge → `combat/idle-ranged-reflex` | Pen SkeletonShield. |
| flat/combat/idle-spider-fight.yaml | pass | action-only | The idle reflex kills a spider starting 14 blocks away (inside the 16-block hostile radius) and keeps >=10 health. |  | merge → `combat/idle-melee-reflex` | Pen Spider. At 20 blocks no encounter began (comment) - keep 14. |
| flat/combat/idle-sword-fight.yaml | pass | action-only | With only a sword (no shield, no armor) the idle reflex kills an approaching zombie and survives. |  | delete: loadout variant: axe, hand and sword+shield pens already prove weapon fallback against the same zombie | Pen Sword (shieldless loadout variant). |
| flat/combat/idle-zombie-skeleton-mixed-fight.yaml | pass | action-only | An armored idle bot kills both a zombie and a bow skeleton arriving together and survives. |  | merge → `combat/idle-ranged-reflex` | Pen Mixed. Goals kill zombie + kill skeleton are global across pens - fine since every skeleton/zombie in that fixture must die. |
| flat/combat/idle-zombie-step-approach.yaml | pass | action-only | With a stone sword the idle reflex kills a zombie standing on a one-block stone step and keeps >=12 health. |  | merge → `combat/idle-melee-reflex` | Pen Step. First-hit delay was logged, never asserted - drop it. |
| flat/combat/incoming-fireball-during-fight.yaml | pass | white-box | During a reflex fight with an 80-hp blaze on a 1-wide bridge, a large fireball summoned when the controller enters its guard phase is reflected and the bot never drops below the bridge. |  | merge → `combat/fireball-deflection` | Pen CrossfireBot. Driver injected createCombatController to time the shot on the internal guard phase; black-box: summon the fireball on a tick-command timer (~3 s after start) and assert bridge cells still netherrack (blocksAt) + survive. Blaze must be >64 blocks from the navigation bridge. |
| flat/combat/incoming-fireball-navigation.yaml | pass | action-only | A navigate across a 1-wide netherrack bridge yields to a large fireball fired when the bot passes x>=2, deflects it, and arrives at x 16 with 20 health. |  | merge → `combat/fireball-deflection` | Pen FireballBot, single navigate {x:16,y:-54,z:0,range:0}. Trigger shot with a run-once tick command: execute if entity @a[name=FireballBot,x=2,...,dx=..] (tag-once). Goals reach, health 20, blocksAt bridge netherrack. |
| flat/combat/incoming-fireball.yaml | pass | action-only | A stationary bot on a narrow bridge deflects an incoming large fireball and takes no damage. |  | delete: stationary deflection on a bridge; the ghast pen (stationary, returns real ghast fireballs) and the navigation pen both cover it | Subsumed by the navigation pen (same bridge, same fireball, stricter: must also arrive). 'stayed on spot' was logged, not asserted. |
| flat/combat/low-health-night-survival.yaml | pass | action-only | At 7 health with only 64 cobblestone, surrounded by 8 zombies and a spider, the bot survives 20 seconds. |  | merge → `combat/wounded-hide` | Pen NightSurvivor: players[].health 7 replaces the /damage arrangement; idle driver; goal survive 20. |
| flat/combat/magma-cube-confined-bystander.yaml | pass | action-only | At 11 health in a bedrock-walled basalt passage with an occupied landing, the bot escapes native magma cubes beside a NoAI neutral enderman, survives, and never hits the enderman. | hide.test.ts 'shelter contact uses a ready shield and a non-sweeping tool beside a neutral Enderman' (bystander rule) | merge → `combat/evade` | Pen Confined (bystander arrangement is the superset). players[].health 11; armor via equipment; cubes need no NoAI toggle (entities activate at start). Bystander-hit witness has no goal: approximate with entityCount enderman min 1, the rule itself is unit-tested. |
| flat/combat/magma-cube-confined.yaml | pass | action-only | At 11 health in the confined basalt passage the bot escapes/strikes native magma cubes and survives. |  | delete: same passage and cubes as magma-cube-confined-bystander minus the bystander; strict subset | Same geometry as the bystander sibling minus the enderman and pickaxe; fold into the same pen. |
| flat/combat/magma-cube-evade.yaml | pass | action-only | An armored, weaponless bot at 11 health escapes native magma cubes along a basalt shelf bordered by lava without touching lava or losing any health. |  | merge → `combat/evade` | Pen Evade with naturalRegeneration false: goal health 11 (no damage, no lava) + survive. |
| flat/combat/meaningful-wait.yaml | pass | action-only | A navigate to x 80 completes alive although a provoked enderman frozen 10 blocks away returns to attack after 10 seconds. |  | merge → `combat/navigation-handoff` | Driver provoked, froze (NoAI, speed 0) and teleported the enderman, then re-enabled and teleported it beside the bot at 200 ticks. Needs tick-command scheduling (scoreboard timer); see harness gaps. |
| flat/combat/melee-lava-edge.yaml | fail | white-box | With an injected outward knockback at the first swing beside lava, the controller's pre-chosen melee stance keeps the bot out of lava, unhurt and grounded. |  | unit test: src/survival/weapons/melee.test.ts (exists: 'melee stance rejects an outward lava landing and accepts a supported side stance') | Run: behaviour: died: knocked into lava from the melee stance. Knockback was faked by setting bot velocity in a wrapped bot.attack; no black-box equivalent. |
| flat/combat/mixed-fight-cover-fire.yaml | pass | white-box | Same as mixed-fight-existing-cover plus fire set in the adopted passage entrance twice; the verdict still only checked kills, survival and exit (fire clearing was evidence only). |  | merge → `combat/cover-fights` | Fire was timed on combat.activePosition(); black-box: set doFireTick false and place fire at (0,-60,0) on a tick-command timer, then add blocksAt air for that cell - stronger than legacy. |
| flat/combat/mixed-fight-existing-cover.yaml | pass | white-box | With a pre-built stone passage, the bot kills a bow skeleton and a zombie and then exits to (0,-60,-4) without digging or building. |  | delete: strict subset of mixed-fight-cover-fire (same passage and mobs, without the fire) | Driver called engageTarget + navigation directly. Black-box: idle reflex fights, then navigate {0,-60,-4, dig:false, scaffold:false}; goals kill skeleton/zombie, reach, blocksAt passage stone unchanged. |
| flat/combat/navigation-combat-resource-progress.yaml | pass | action-only | An async navigate through three skeletons reports combat resource totals (arrows fired/recovered, shield blocks) that reconcile with natively observed packets and across wait deltas. | navigate outcome folds into combat/skeleton-crossfire-navigation | unit test: src/session/progress.test.ts + src/runtime/combat-resource-events.test.ts (exist) | Exercises the MCP async submit/wait protocol, which tests/minecraft deliberately does not. Arrival half is kept by the crossfire scenario. |
| flat/combat/navigation-creeper-blocked-retreat.yaml | pass | action-only | A navigate down a 1-wide passage blocked by a creeper (with a concealed zombie nearby and a climbable rear step) reaches x 11 alive. |  | merge → `combat/creeper-navigation` | Pen BlockedRetreat. EnderSeeker 2026-09-11 blocked-retreat handoff (unit: decision.test.ts). Legacy prepare equipped diamond armor+shield: use players[].equipment. Reset fills -> geometry. |
| flat/combat/navigation-creeper-cave-crossfire.yaml | pass | action-only | A navigate through a low stone tunnel with side chambers past 2 skeletons, a zombie and a creeper arrives with >=12 health. |  | merge → `combat/creeper-navigation` | Pen CaveCrossfire. mixedTicks>0 (proof of a mixed encounter) cannot be asserted black-box; arrangement guarantees it. |
| flat/combat/navigation-creeper-desert-crossfire.yaml | pass | action-only | A navigate across open sand past 2 skeletons, a husk and a creeper arrives with >=12 health. |  | delete: open-ground variant of navigation-creeper-cave-crossfire (same mob mix); the cave version is harder | Pen DesertCrossfire; same as cave variant on sand. |
| flat/combat/navigation-creeper-pair-handoff.yaml | pass | action-only | With bow, sword and armor, two navigates (to x 40 then back to 38) clear or pass a creeper pair met under navigation and arrive alive. |  | merge → `combat/navigation-handoff` | Road encounter 5 (creeper pair). Without a bow the policy evades a pair; the road loadout carries one. |
| flat/combat/navigation-creeper-wall-pocket.yaml | pass | action-only | From a 3-sided stone recess with a creeper and spider at its mouth and a skeleton beyond, a navigate reaches open ground at x 18 alive. |  | delete: full-health variant of navigation-creeper-wounded-pocket (same recess shape and mobs) | Pen WallPocket; equipment for armor+shield (legacy prepare). |
| flat/combat/navigation-creeper-wounded-pocket.yaml | pass | action-only | At 13 health in a stepped recess with two creepers, a spider and a skeleton, a navigate reaches x 18 (y -62) alive. |  | merge → `combat/creeper-navigation` | Pen WoundedPocket; players[].health 13 already used. |
| flat/combat/navigation-fight-handoff.yaml | pass | action-only | Two navigates (x 40 then back to 38) with sword+shield hand off to the reflex for a zombie met en route and still arrive alive. |  | merge → `combat/navigation-handoff` | Road encounter 1 and the two-request shape (second navigate proves the body was released). |
| flat/combat/navigation-four-encounters.yaml | pass | white-box | One navigate to x 45 with an axe succeeds through four 1-hp NoAI zombies summoned on the route, with hostile avoidance (stepFieldProvider) disabled. |  | merge → `combat/navigation-handoff` | Road encounter 3: a 1-wide corridor holding four NoAI zombies makes avoidance impossible without the runtime override. Black-box loses the axe-only loadout; fine (weapon choice is not the outcome). |
| flat/combat/navigation-gauntlet-fight.yaml | pass | action-only | An armored bot navigates to x 60 alive past a zombie pair and then a bow skeleton holding the road. |  | merge → `combat/navigation-handoff` | Road encounters 2 and 4. |
| flat/combat/navigation-mixed-creeper-management.yaml | fail | action-only | With hide forbidden by policy, a navigate across a bounded arena past 2 creepers and 3 zombies arrives with >=12 health, at least one reflex encounter, no hide response and <=2 explosions. |  | merge → `combat/creeper-navigation` | Run: stale: arrived, but the arena never provoked a hostile response, which the driver requires. Pen MixedRoute: action-sequence set_survival_policy {combat:{hide:never}} then navigate. 'no hide'/'encounter happened' need a read_recent_events check in the driver; explosion cap is a tactic - drop it, health 12 holds the outcome. |
| flat/combat/navigation-pack-fight.yaml | pass | action-only | An armored bot's two navigates (x 40, back to 38) get past an abreast zombie pair alive. |  | merge → `combat/navigation-handoff` | Road encounter 2 (shared with gauntlet). |
| flat/combat/navigation-skeleton-crossfire.yaml | fail | action-only | A navigate through a compact walled arena past three skeletons reaches x 14 with no damage. |  | merge → `combat/skeleton-crossfire-navigation` | Run: behaviour: did not arrive; 9 arrows, minimum health 17. Final walled section of the route. Legacy aborted on first damage; use the no-regen template + health 20. |
| flat/combat/navigation-skeleton-elevated-crossfire.yaml | pass | action-only | A navigate to x 44 past one ground and one platform-mounted skeleton takes no damage. |  | merge → `combat/skeleton-crossfire-navigation` | Middle section (elevated platform). |
| flat/combat/navigation-skeleton-first-shot.yaml | pass | action-only | A navigate to x 44 past two bow skeletons starting outside contact range takes no damage, i.e. the guard is up before the first shot. |  | merge → `combat/skeleton-crossfire-navigation` | Opening open-ground section. |
| flat/combat/nether-vegetation-shelter.yaml | pass | white-box | buildProtection completes a 2-high, 3-wide wall through warped roots, crimson roots and nether sprouts with 6 cobblestone. |  | merge → `combat/wounded-hide` | Pen Vegetation: plants in the wall cells around a wounded bot, blocksAt cobblestone at those cells. If hide does not share buildProtection's replaceable-plant path, add a case to src/survival/positioning/combat/build-protection.test.ts (new) instead. |
| flat/combat/occupied-wall-placement.yaml | pass | white-box | placeBlock refuses a full wall cell occupied by a wither skeleton before sending a packet, then places once it moves. |  | unit test: src/world/placement.test.ts (exists: 'full-cube placement refuses an observed body ...') | Packet counting via wrapped _client.write; pure placement unit. |
| flat/combat/persistent-blaze-projectile.yaml | pass | white-box | A ScenarioCombat engage on a NoAI blaze with a slow small fireball in flight kills the blaze instead of spinning on guarded-approach retries. | controller.test.ts guarded-approach yield cases (partly) | merge → `combat/blaze-fire-idle` | Black-box: NoAI blaze 5 blocks away + a slow small_fireball entity (Motion 0,0,-0.05) from YAML; idle reflex; goal kill blaze within timeout. The 100-attempt spin dump was diagnostics. |
| flat/combat/piglin-attribution.yaml | pass | white-box | A bot in iron+gold armor that hits a piglin while standing in fire survives the piglin's aggression overlapping source-less fire damage for 20 s. | threats.test.ts piglin cases (partly) | merge → `combat/neutral-bystanders` | Pen PiglinProbe. Provoke via tick-once damage ... by player (not bot.attack); fire via a fire block at the start cell. Goals survive + completion. |
| flat/combat/piglin-other-target.yaml | pass | action-only | A gold-booted bot beside a piglin retaliating against a hoglin never attacks, is never hurt and the reflex never takes the body. |  | merge → `combat/neutral-bystanders` | Pen PiglinBystander. Arrange piglin aggression with a tick-once damage @e[tag=subject] by @e[tag=other] and regeneration on the hoglin. Goals health 20, entityCount hoglin min 1, piglin min 1. |
| flat/combat/raised-enderman-roof.yaml | pass | white-box | CombatPosition.prepareRoof builds an enderman roof from a raised basalt cell whose adjacent support column has no floor at standing level, without damage. | position.test.ts 'a raised roof budgets its missing foundation ...' (partly) | unit test: src/survival/positioning/combat/position.test.ts (exists: raised roof budget) | white-box CombatPosition.prepareRoof called directly; Black-box needs a provoked enderman (tick-once damage by player) and the shelter response; goal blocksAt roof cells non-air / survive. |
| flat/combat/respawn-metadata.yaml | pass | action-only | After burning to death in lava and respawning, view_status reports burning not true and full health. |  | unit test: src/actions/view-status/view-status.test.ts (new case: respawn clears own entity metadata) | Driven by chat /tp into lava and a direct createViewStatusAction call. Real fix lives in the forked mineflayer's respawn handling; pin it there or in view-status. |
| flat/combat/sealed-in.yaml | pass | action-only | At 7 health inside a pre-built 1x1 stone box with a NoAI spider 15 blocks off, the bot stays inside (cap intact) and naturally recovers to >=10 health. | hide.test.ts 'a bot already sealed in is hidden, not failed' (exists) | merge → `combat/wounded-hide` | Pen SealedIn. Second half of the 2026-09-04 livelock (unit-tested in hide.test.ts / hostile.test.ts). players[].health 7, regen on, goals health 10, blockAt cap stone. |
| flat/combat/shield-break-replacement.yaml | pass | white-box | When a native blaze breaks the nearly-worn equipped shield mid-volley, the controller equips the carried spare and blocks twice more. |  | unit test: src/survival/responses/fight/projectile-guard.test.ts (exists: 'broken guard equips a spare and restarts readiness') | Asserted mechanism (block count) via ScenarioCombat.engage hold; outcome-only black-box (survive a 1024-hp blaze) would not prove the swap. |
| flat/combat/shielded-melee-creeper-escape.yaml | pass | white-box | A creeper summoned at the first swing interrupts shielded melee; the bot sprints out of fuse range without sprinting while shielded/crouched, no explosion, health 20. |  | unit test: src/survival/control/combat/controller.creeper.test.ts (exists: 'an incidental creeper releases the melee shield before sprinting clear') | Creeper spawn hooked into a wrapped bot.attack; assertions are posture tactics. |
| flat/combat/shielded-melee-to-bow.yaml | pass | white-box | After a shielded sword hit sends a blaze out of reach, the bow switch fires real arrows (server stops shield use) and kills it. |  | unit test: src/survival/weapons/item-use.test.ts (exists: 'drawing a bow releases server shield use even after local posture was invalidated') | Target teleport was keyed on the first hit; could become a tick command on HurtTime, but the guarantee is the item-use release. |
| flat/combat/skeleton-bones-limited-ammo.yaml | pass | action-only | collect_mob_drop skeleton/bone x3 with one arrow, bow, sword, shield, food and cobblestone returns 3 bones and the bot survives. | hunt/arrow-hunt-spends-no-arrows (different quarry drop and ammo budget) | merge → `hunt/skeleton-hunts` | single-action driver; armor via equipment (legacy hunter wear_armor), shield stays in inventory as before. Goals hasItem bone 3, survive, completion. |
| flat/combat/skeleton-retreat-shield.yaml | pass | white-box | A wounded (max 11) bot evading a skeleton blocks a repositioned real arrow and finishes a safe separation without losing health. | controller.shield-facing.test.ts (partly) | unit test: src/survival/perception/combat/shield-projectiles.test.ts (exists: 'retreat and shield facing detect an arrow which falls into the body below its original ray') | Arrow and shooter repositioned with /data and /tp; evade invoked via executeHostileResponse. Black-box wounded-vs-skeleton outcome lives in combat/wounded-shelter. |
| flat/combat/standing-down.yaml | pass | action-only | At 7 health on bedrock with no blocks and a NoAI spider in sight, after 600 idle ticks a navigate along a 1-wide corridor still reaches x 16 alive. | hostile.test.ts 'a hide that could not be built is recorded once and then the reflex stands down' (exists) | merge → `combat/wounded-navigation` | Player StandDown: players[].health 7, waitForTicks 600, then navigate. First half of the 2026-09-04 livelock. |
| flat/combat/wall-in-clearance.yaml | pass | white-box | hideInPlace from a fractional position (z 0.146) clears the body from adjacent wall cells and completes the shell without moving cells. | hide.test.ts refusal case only | unit test: src/survival/responses/hide.test.ts (exists: overlap clearance refusal and recentering) | white-box hideInPlace from z 0.146; Pen Clearance: pos z 0.146, health 7, NoAI hostile in sight to trigger hide; blocksAt cobblestone on the 8 wall cells + cap. Unit test covers only the refusal side. |
| flat/combat/wall-in-cliff-insufficient.yaml | pass | white-box | With only 10 cobblestone beside a drop, hideInPlace fails, spends every block and leaves cells open. |  | unit test: src/survival/responses/hide.test.ts (new case: insufficient blocks over a drop fails without extending the footprint) | Expected-failure mechanism; no world outcome worth a black-box pen. |
| flat/combat/wall-in-cliff.yaml | pass | white-box | hideInPlace beside a 4-deep drop builds the wall over the drop using the completed roof as support, without extending the footprint. | hide.test.ts 'a wall over a drop is built on a floor extension ...' (related) | merge → `combat/wounded-hide` | Pen Cliff: blocksAt cobblestone on wall cells over the drop. |
| flat/combat/withdraw-navigation-blocked.yaml | pass | action-only | With an active blaze fight on a bedrock-sealed bridge, defend_only+hide never then a navigate to x 60 fails (capability_limit evade or no path) while the bot stays alive behind x 25. |  | merge → `combat/withdraw-navigation` | Player BlockedWithdraw: seal with geometry instead of chat /fill; expect navigate failed. Needs a per-player driver (waitForTicks, policy, navigate with expectation). |
| flat/combat/withdraw-navigation-skeleton.yaml | pass | action-only | Mid-fight with two skeletons on a bridge over lava, defend_only+hide never then a navigate to x 60 arrives alive. |  | merge → `combat/withdraw-navigation` | Player SkeletonWithdraw. Legacy timed the request on combat.activeEngagement(); black-box: waitForTicks until shots are certain (~100). |
| flat/combat/withdraw-navigation.yaml | pass | action-only | Mid-fight with two blazes on a nether-brick bridge over lava, defend_only+hide never then a navigate to x 60 arrives alive without resuming pursuit. |  | merge → `combat/withdraw-navigation` | Player BlazeWithdraw. 'no new pursuit' was never asserted; reach+survive is the outcome. |
| flat/combat/wounded-blaze-shelter.yaml | pass | action-only | A shieldless bot at 10 health between two native blazes (18 blocks each side) survives and recovers to >=18 health. |  | merge → `combat/wounded-ranged-shelter` | Pen Blaze. players[].health 10, regen on; driver idles; goal health 18 + survive. Legacy opened the runtime only after the first shot - with a live runtime from start the outcome is the same. |
| flat/combat/wounded-burning-shelter.yaml | pass | action-only | As wounded-blaze-shelter but with a shield and starting on fire from a lava touch; still recovers to >=18. |  | merge → `combat/wounded-ranged-shelter` | Pen Burning: start in a fire block (or tick-once lava set/clear) to arrive burning. |
| flat/combat/wounded-cave-ascent.yaml | fail | action-only | At 2 health and hunger below 18 with no food, a dig+scaffold navigate from a cavern floor up a staircase reaches the plateau alive though a NoAI zombie watches from a ledge. | hostile-field.test.ts + hide.test.ts 2026-09-09 cases (exist, partly) | merge → `combat/wounded-navigation` | Run: stale: setup could not drain hunger below 18. Player Ascent. The 2026-09-09 livelock, built to the block. Hunger needs a tick-once hunger effect + wait (no players[].food); zombie placement mid-route needs a position-triggered tick summon. |
| flat/combat/wounded-ranged-unbuildable.yaml | pass | action-only | A shieldless bot at 10 health on a bedrock pad without blocks survives two blazes and recovers to >=18. |  | merge → `combat/wounded-ranged-shelter` | Pen Unbuildable (no cobblestone). |
| flat/combat/wounded-skeleton-shelter.yaml | pass | action-only | A shieldless bot at 10 health between two bow skeletons 12 blocks each side survives and recovers to >=18. |  | merge → `combat/wounded-ranged-shelter` | Pen Skeleton. |
| flat/combat/wounded-soul-fire-surround.yaml | pass | action-only | At 5 health on soul soil with soul fire in all four adjacent cells, under two blazes, the bot survives and recovers to >=18. | recover.test.ts 'a closed shelter containing soul fire is not a recovery position' (related) | merge → `combat/wounded-ranged-shelter` | Pen SoulFire, players[].health 5. |
| flat/combat/wounded-supply-return.yaml | pass | action-only | From 9 health and hunger <18, a navigate to x 30 past two zombies and a skeleton arrives alive still carrying 8 iron ingots. |  | merge → `combat/wounded-navigation` | Player SupplyReturn: health 9 via players[].health, armor+shield via equipment; hunger via tick-once effect; regen gamerule on. |

### flat/pathfinder (72)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| flat/pathfinder/ascending-jump-magma-landing.yaml | pass | white-box | An ascending two-block jump off a 20-high pillar lands and stays (0.3 radius after 40 ticks) on a bedrock pad between two magma blocks, with no magma contact and full health | pathfinder/gauntlet-lava-parkour (partly: magma detour, maximum gaps) | merge → `pathfinder/gauntlet-lava-parkour` | New "pillar hops" checkpoint. Under no-regen, magma contact shows as lost health. The recorded fractional takeoff x=0.10229 is lost because a course arrives at the cell centre; movement-controller.test.ts landing-brake cases cover the controller. |
| flat/pathfinder/brute-corridor-detour.yaml | pass | white-box | With a NoAI piglin brute in the corridor, the route takes the far lane (25 east) and its closest approach never comes inside the 16-block acquisition range; dividing walls intact, brute alive, full health |  | merge → `pathfinder/hostile-lane-choice` | The driver registered the hostile step field itself; the production runtime already does (minecraft-runtime.ts:470). Closest approach over time is not a Mine Labs goal. Either use AI-enabled brutes caged in a barrier-plugged corridor, so entering range costs health, or add a latched entityDistance goal (see harness gaps). Unit: hostile-field.test.ts "a mob that wins the fight on arrival is priced before it can start one". |
| flat/pathfinder/brute-pack-corridor-detour.yaml | pass | white-box | As brute-corridor-detour with three adjacent brutes: the far lane is still taken, never inside 16 blocks, both walls intact, all three brutes alive |  | merge → `pathfinder/hostile-lane-choice` | This is the stricter of the two brute rows, so use the pack as the course's brute stage. Cap scaling is already unit-tested: hostile-field.test.ts "the cap rises with the severe hostiles reaching a cell". |
| flat/pathfinder/bucket-drop-displaced.yaml | pass | white-box | An entity_velocity packet injected 4 airborne ticks into a planned bucket drop changes the landing; the route still finishes with every pour's water recovered and full health |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Pinned by "an impulse before a planned pour redirects its landing" and "a redirected planned drop counts both pours and both independently observed recoveries". A black-box driver cannot inject the impulse. |
| flat/pathfinder/bucket-drop-route.yaml | pass | action-only | navigate (dig and scaffold false, range 0) from the top of an unbreakable 15-block bedrock tower reaches the ground through a planned water-bucket drop, with full health and the water bucket recovered |  | migrate → `pathfinder/bucket-drop-route` | single-action navigate {x:1,y:-59,z:0,range:0,dig:false,scaffold:false}, no-regen template. Goals: reach, health 20, hasItem water_bucket 1, survive. The driver's internal bucketDropTotals/waterRecovered check becomes the hasItem goal. |
| flat/pathfinder/camp-door-replan.yaml | pass | action-only | Starting inside a furnished camp (two chests, furnace, table), navigate range 0 turns around the adjacent chest and leaves through a closed birch door, which is closed again afterwards | pathfinder/gauntlet-lava-parkour (door activation only) | merge → `pathfinder/doorway-course` | The door-closed check becomes blockAt "birch_door[open=false]" for both halves. Mine Labs blockAt runs execute if block, so block-state predicates work. Keep the cramped 2.31,1.59 stance beside the chest, either as the course start or as a leg arrival. |
| flat/pathfinder/cave-ledge.yaml | pass | white-box | A replica of the natural run-12 stone ledge ascent reaches the target at full health, and the diagonal step_up 6,-53,5>5,-52,6 never collides with the ceiling while airborne |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | "a constrained step-up waits for Baritone's alignment before jumping" pins the head-bonk alignment, and catalogue.test.ts pins the diagonal corner check. The outcome alone (reach plus health) cannot see a bonked first jump that a second jump recovers. Optionally add the geometry to cave-excavation-course as an arrival-only leg. |
| flat/pathfinder/cavern-ore-return.yaml | pass | action-only | collect_block iron_ore x3 (scaffold allowed) tunnels through a hill into a cavern seam, then use_container deposits raw_iron x3 in the surface chest; both the chest and bot memory hold exactly 3 |  | merge → `collect/ore-return-deposit` | The header comment about mineflayer-pathfinder PR #365 is obsolete because that dependency was removed. Use the drivers/preserve-storage.ts steps and its use_container inspect for exact chest contents. The SQL memory cross-check is dropped. |
| flat/pathfinder/corridor-detour.yaml | pass | white-box | A NoAI zombie stands in the corridor and an open detour runs 9 blocks east: arrive at full health, zombie alive, dividing wall intact. Lane choice was only a diagnostic |  | merge → `pathfinder/hostile-lane-choice` | The driver registered the step field itself; the production runtime does this. Check whether the production hostile reflex engages a NoAI zombie it walks past. If it does, entityCount min 1 becomes a real lane discriminator. If not, lane choice stays unasserted, as it was before. |
| flat/pathfinder/corridor-dig.yaml | pass | white-box | One dirt block under a roof plugs the detour mouth; the route breaks that block (air at 9,-60,-2) instead of passing the zombie. Wall intact, full health |  | merge → `pathfinder/hostile-lane-choice` | The course must run with dig:true (navigate-route's dig flag), so that this stage and the intact-wall goals are meaningful. |
| flat/pathfinder/corridor-forced.yaml | pass | white-box | With no detour, the route walks the zombie's corridor (the field is a price, not a prohibition) without tunnelling; walls at 5,-60,-8 and 1,-60,-8 intact |  | merge → `pathfinder/hostile-lane-choice` | If the production hostile reflex fights the NoAI zombie at this stage, drop entityCount for it. Arrival plus the intact walls remain the assertion. |
| flat/pathfinder/deep-vertical-ore-return.yaml | pass | action-only | collect_block iron_ore x3 from a seam 11 blocks down and 2 east (a steep excavation), then deposit raw_iron x3 in the surface chest; chest and memory counts exact |  | merge → `collect/ore-return-deposit` | Fold together with cavern-ore-return using two seams of different ores (for example iron steeply below and gold or copper in the cavern), so each collect_block request is unambiguous. |
| flat/pathfinder/dig-route-pickaxe-breaks.yaml | pass | action-only | A dig route whose only diamond pickaxe (damage 1556) breaks returns partial TOOL_TIER_LOST while grounded; a second identical request completes with the stone pickaxe still held |  | unit test: src/actions/navigate/navigate.test.ts (exists) | Pinned by "dig navigation safely settles partial when its best pickaxe capability drops". The black-box form is blocked because players[].equipment cannot carry item components such as damage (see harness gaps). The driver arranged the inventory with op chat commands. |
| flat/pathfinder/dripstone-wedged-raw.yaml | pass | action-only | While wedged on a dripstone tip, a raw_action dig of that tip, a sneak control and a raw place of cobblestone at -1,-59,0 all report effectObserved |  | delete: diagnostic probe of raw_action on an odd stance; no incident; raw-action.test.ts already pins observed-effect semantics | Used a legacy prepare hook to teleport onto the tip. |
| flat/pathfinder/dripstone-wedged.yaml | pass | action-only | Starting settled on a supported upward dripstone tip in a one-wide pit, navigate range 0 to 4,-59,0 succeeds at full health | pathfinder/cave-excavation-course (dripstone treads, but not a wedged start) | merge → `pathfinder/dripstone-stances` | A legacy prepare hook teleported the bot onto the tip after the handshake. Try players[].pos [0.5,-57,0.5] directly: the host waits for landing, and a tip is collision support. If the landing wait rejects it, this needs the start-stance exception (see harness gaps). |
| flat/pathfinder/drop-knockback-landing.yaml | pass | white-box | A recorded sideways fireball entity_velocity arrives during a two-block drop over lava; the drop controller corrects and lands on the target ledge without touching lava |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Pinned by "a drop corrects sideways knockback after releasing its approach". The impulse was recorded in architecture-qualification trial 3 (1788848723126). Velocity injection is not black-box. |
| flat/pathfinder/drop-support-removed.yaml | pass | white-box | A /setblock fired on route_committed removes the landing support; the route is invalidated and the bot stays on the upper ledge at full health |  | unit test: src/navigation/execution/route-executor.test.ts (exists) | Covered by "route invalidation interrupts movement at a cleaned physical checkpoint" and "a terminal world invalidation releases a cancelled jump without another physics tick". A world edit timed to a navigation event cannot be expressed black-box. |
| flat/pathfinder/fire-route.yaml | pass | action-only | Four runs on one lane (fire and soul fire, each pre-placed or ignited mid-route): navigate range 0 arrives with zero body-fire contact, unchanged health, and the fire still present |  | merge → `pathfinder/gauntlet-lava-parkour` | Add a fire lane checkpoint with static fire on netherrack and soul fire on soul_soil; under no-regen, health 20 detects any contact. Mid-route ignition can be a tick command, e.g. execute if entity @a[name=GauntletBot,x=..,dx=..] run setblock X Y Z fire keep. The arena needs doFireTick false. |
| flat/pathfinder/footing-during-reflex-handoff.yaml | pass | white-box | A fixture hostile claim queued during an airborne ascent, plus a recorded impulse: footing recovery takes over, the lower claim is released, and the bot lands on the 3x3 pad above lava at full health |  | unit test: src/navigation/execution/route-executor.test.ts (exists) | Covered by "a cancelled step-up releases after knockback lands on another safe cell" and by survival/responses/footing.test.ts. The driver built a ReflexDriver and its claims by hand. |
| flat/pathfinder/footing-takeover-during-ascent.yaml | pass | white-box | A recorded pack impulse is injected mid step-up through the runtime; the bot arrives at 2,-39,0 grounded, at full health, and never drops below -40 |  | unit test: src/survival/responses/footing.test.ts (exists) | Covered by "an observed lower terrace preserves protection and resumes only after actual landing" plus the route-executor knockback cases. Injecting a velocity packet is not black-box. |
| flat/pathfinder/ground-column-choice.yaml | pass | action-only | navigate with y omitted under leaves, under a stone overhang and under a bedrock roof is refused NAVIGATION_HEIGHT_REQUIRED each time without moving; an explicit y=-60 then arrives at 12,-60,0 |  | merge → `pathfinder/navigation-refusals` | The refusal logic is also unit-tested: actions/navigate/navigate.test.ts "omitted height refuses a canopy, overhang, or Nether roof". |
| flat/pathfinder/house-door-exit.yaml | pass | action-only | navigate with digging allowed, from inside a closed house to a point behind its back wall, leaves by the front door; the back wall is intact and the door is closed after passage | pathfinder/gauntlet-lava-parkour (door activation only) | merge → `pathfinder/doorway-course` | The course needs dig:true so the intact-wall goals discriminate. The door-closed check becomes blockAt oak_door[open=false] for both halves. |
| flat/pathfinder/item-pickup-area.yaml | pass | action-only | pick_up_items diamond with radius 12 collects all 6 diamonds from three drops (one on a ledge) and leaves the gravel |  | merge → `pathfinder/item-pickup-course` | Express gravel==0 either as entityCount item min 1 after the diamonds are gone (only the gravel entity should remain) or as a hasItem max goal (see harness gaps). |
| flat/pathfinder/item-pickup-chase.yaml | pass | white-box | Four diamonds are all collected at full health: one on open floor, one behind a wall, one a step down below a ledge, and one drifting in a current |  | merge → `pathfinder/item-pickup-course` | The driver called pickupObservedItem directly; the black-box form is pick_up_items item:diamond over the area, with hasItem diamond at the course total. |
| flat/pathfinder/item-pickup-ledge.yaml | pass | white-box | A drop summoned with motion and a 20s pickup delay rolls behind a one-block ledge after first entering reach, and is still collected |  | merge → `pathfinder/item-pickup-course` | The post-login summon with motion cannot be expressed, so fold this in as a static drop resting below a one-block ledge. The stale-reach mechanism is unit-tested: goals.test.ts "an adjacent drop stops routing only when the actual body is in pickup reach". |
| flat/pathfinder/jump-exact-arrival.yaml | pass | action-only | A sprint, a two-block drop, a turn and a short jump settle in exactly cell 5,-60,2 after 10 ticks of coasting |  | merge → `pathfinder/movement-course` | New checkpoint with range 0; navigate-route already waits 10 ticks before checking. Unit: movement-controller.test.ts "a settled jump does not report the target cell while residual coast will leave it". |
| flat/pathfinder/lava-above-excavation.yaml | pass | white-box | A drop excavation through warped nylium is refused when it would redirect lava beside the head cell into the landing: nylium intact, full health | pathfinder/lava-containment (overhead and lateral lava; this is a different drain case) | merge → `pathfinder/navigation-refusals` | Expect navigate to fail; goals are blockAt warped_nylium and health. The lava must settle first (the driver waited 80 ticks), so put this step late in the sequence. |
| flat/pathfinder/leaf-hemmed-diagonal-ascent.yaml | pass | white-box | A dirt tread is reached by the cardinal staircase; the leaf-hemmed diagonal step_up -1,-59,0>0,-58,-1 is never started |  | merge → `pathfinder/movement-course` | Reproduces the live canopy failure, which looped on the diagonal. The black-box form asserts arrival and health only; the never-attempted-edge rule is pinned by catalogue.test.ts "a block on the diagonal under an obstructed corner". |
| flat/pathfinder/long-underwater-exit.yaml | pass | action-only | Two navigates leave an air cavern under a lake by a dry route of about 80 blocks and walk home, without digging the water-touching dirt roof; dry at the exit and at home, full health |  | migrate → `pathfinder/long-underwater-exit` | Use navigate-route with dig:true (the discriminator is choosing not to dig) and legs exit 81,-51,0 range 2, home 0,-51,10 range 2. Keep the forceload in reset. |
| flat/pathfinder/momentum-step-up-corner.yaml | pass | white-box | Sprint into a step-up onto a one-wide gold corner over lava, then turn north along a one-wide shelf, at full health. The driver also required handoff speed above 0.035 | pathfinder/gauntlet-lava-parkour (step-ups) | merge → `pathfinder/gauntlet-lava-parkour` | The handoff-speed assertion pins a tactic and is dropped. Unit: movement-controller.test.ts "a continuous step-up brakes inherited speed and hands off only after landing". |
| flat/pathfinder/moving-item-pursuit.yaml | pass | white-box | A diamond moved 0.08 blocks per tick by a tick command is pursued at once and collected |  | merge → `pathfinder/item-pickup-course` | Keep the tick-command mover (tag moving_pickup). The 10-tick immediacy assertion is dropped; the outcome is hasItem within the timeout. |
| flat/pathfinder/netherrack-bridge.yaml | pass | action-only | Cross a 7-wide lava gap carrying only netherrack: a bridge block appears at 1,-60,0 and the bot arrives at full health | explore/necessary-lava-bridge (netherrack crossing via explore_frontier) | merge → `pathfinder/scaffold-course` | Uses navigate's default scaffold:true. The netherrack material itself is already guarded by explore/necessary-lava-bridge and the default scaffold list, so the course can bridge with its own material. |
| flat/pathfinder/no-dig-camp.yaml | pass | action-only | A dig:false exit through a camp door succeeds with zero building cells changed; the door is then replaced by cobblestone, and the sealed route fails 'no path' with the camp unchanged |  | merge → `pathfinder/doorway-course` | The door half goes in doorway-course. The sealed half becomes a navigation-refusals step: navigate into a sealed cobblestone box with dig:false, expect failed 'no path', walls intact. Two arenas replace the mid-run rearrangement. |
| flat/pathfinder/one-sided-head-bonk-diagonal-ascent.yaml | pass | white-box | With only one upper corner of the diagonal rise blocked, the diagonal edge is never started and the cardinal stair reaches the target |  | unit test: src/navigation/movements/catalogue.test.ts (exists) | The row "a block on the diagonal under an obstructed corner" is exactly this one-sided case. The black-box outcome would be identical to leaf-hemmed, which goes to movement-course. |
| flat/pathfinder/open-ocean-surface.yaml | pass | action-only | From feet y=61.889 just below an open-ocean surface with no floor, navigate swims up and on to the beach, ending grounded at full health |  | unit test: src/navigation/movements/catalogue.test.ts (exists) | EnderSeeker request 47, 2026-09-09. Pinned by "a bot just below the ocean surface can rise without a floor beneath it". The black-box form needs an in-water start, which the host's landing wait does not allow today (see harness gaps). |
| flat/pathfinder/parkour-landing-brake.yaml | pass | white-box | With a recorded run-up velocity injected, a 4-block parkour onto a single nether-brick block over lava stops on that block | pathfinder/gauntlet-lava-parkour (4-block parkour onto one-deep pads over lava) | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Pinned by "a landing past the pad's centre brakes while any of the body still has support". The driver set the entity velocity directly. |
| flat/pathfinder/parkour-low-ceiling.yaml | pass | white-box | Over a lava gap whose parkour arc would hit a soul-soil block in the 4th cell above takeoff, the obstructed parkour is never started and the bot arrives at full health (scaffold available) |  | merge → `pathfinder/scaffold-course` | The recorded Nether jump reached feet+1.249. The outcome (a bonk drops the bot into lava and kills it) is black-box observable. The never-attempted-edge rule is pinned by catalogue.test.ts "a gap jump rejects a ceiling in the fourth cell above the takeoff feet". |
| flat/pathfinder/parkour-pillar.yaml | pass | white-box | With placement restricted to one cell by a custom decidePlace, a rising parkour lands and hands off to a pillar placement |  | delete: physically simulates one internal handoff under a hand-built movement policy; without that restriction the bot builds a staircase instead, so no black-box outcome exists | Nearest unit coverage: the pillar placement-jump cases in bot.test.ts. |
| flat/pathfinder/parkour-takeover.yaml | pass | white-box | A body claim during a 4-cell jump gets ownership only after the landing settles on the far block |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Covered by "cancelling a committed gap retains flight controls and settles the landing" and route-executor.test.ts "a contact cancellation before the route tick still launches and lands a committed run-up". |
| flat/pathfinder/partial-detour.yaml | pass | white-box | With search budgets forced to zero/1s, a U-shaped detour is followed past its initial retreat instead of reversing truncated route prefixes |  | unit test: src/navigation/search/search.test.ts (exists) | Pinned by "a partial detour keeps its useful endpoint instead of cutting before the turn away from the goal". The forced search limits are internal. |
| flat/pathfinder/passage-restoration.yaml | fail | action-only | Six door and gate cases: adjacent exit; an already-open door left open; a closed door restored across a mid-route replan; a doorway cancelled mid-passage left open with evidence; a gate closed; an occupied doorway left open and reported |  | merge → `pathfinder/doorway-course` | Run: behaviour: the cancelled case stopped in the doorway with the door left open. The static cases (already-open stays open, closed door restored, gate closed, adjacent exit) fold in as legs with blockAt state predicates. Replan, cancel and occupied need mid-route injection; they are unit-tested in opened-passages.test.ts and route-executor.test.ts "a replanned step enters its owned open doorway before restoration". |
| flat/pathfinder/pillar-short-ledge-handoff.yaml | pass | action-only | navigate build:true pillars 8 up beside a two-block ledge and steps onto it at full health |  | merge → `pathfinder/scaffold-course` | The handoff sample count was a diagnostic; the outcome is arrival plus health. |
| flat/pathfinder/pillar-tower.yaml | pass | action-only | An adjacent mid-air y is refused NAVIGATION_TARGET_UNSUPPORTED (naming the ground y, no movement, no scaffold spent); build:true then pillars 5 up with dirt at -59 and -55 |  | merge → `pathfinder/scaffold-course` | The refusal half is unit-tested (navigate.test.ts "an explicit target cell is routed to only when the bot could stand there") and could also be a navigation-refusals step. The build half becomes the course's straight pillar. |
| flat/pathfinder/preserve-spawner.yaml | pass | white-box | A route with digging allowed whose only way through is a spawner stops before it; the spawner is intact |  | merge → `pathfinder/navigation-refusals` | Expect navigate to fail; goal blockAt spawner. The policy is also unit-tested: movement-policy.test.ts "routes preserve what a player built or uses". |
| flat/pathfinder/route-cancelled-midway.yaml | pass | white-box | A sprinting route stopped by stopSignal at about 1.6s comes to rest before x=30 holding no controls; a fresh route then completes |  | unit test: src/navigation/execution/route-executor.test.ts (exists) | Pinned by "route cancellation clears controls and detaches its physics-tick subscription"; navigation-run.test.ts covers admitting the next run. A black-box driver cannot cancel an action. |
| flat/pathfinder/scaffold-cobbled-deepslate.yaml | pass | white-box | navigate build:true pillars 5 up using only carried cobbled_deepslate (from the policy's default list), placing 5 and standing on top |  | merge → `pathfinder/scaffold-course` | The driver constructed SurvivalPolicyState itself; the runtime does that. Give the course cobbled_deepslate as its only scaffold, so every placed-block goal also checks the default list. Unit: survival-policy.test.ts. |
| flat/pathfinder/search-displacement.yaml | pass | white-box | With search slices monkeypatched to zero budget and a ledge impulse applied, a stale route start is never committed |  | unit test: src/navigation/orchestration/navigation-run.test.ts (exists) | Covered by "stationary search revalidates its start after ${displacement} motion" and "a continuation rechecks ${displacement} after waiting for its search". |
| flat/pathfinder/search-knockback-ledge.yaml | pass | white-box | A recorded EyesBot impulse arrives during the search position hold; the body stays on the two-block ledge above lava |  | unit test: src/navigation/steering/supported-position.test.ts (exists) | From the 2026-09-08 EyesBot death. The mechanism is pinned by "combat holds the supporting cell through a knockback hop"; add the recorded velocity (0.167125, 0.275125, -0.13725) as a new replay case. |
| flat/pathfinder/shallow-water-surface.yaml | pass | action-only | Rise from a two-deep flowing pickup hole to 1,-59,0, holding the column against the current; survive and complete |  | merge → `pathfinder/water-course` | Unit: swimming.test.ts "a newly dug pickup hole retains its verified ascent as air becomes flowing water". |
| flat/pathfinder/short-jump-edge-landing.yaml | pass | white-box | A two-block jump off a 20-high pillar lands on the far edge and stays within 0.3 of the pad centre for 40 ticks, with no lava and full health | pathfinder/gauntlet-lava-parkour (jump section) | merge → `pathfinder/gauntlet-lava-parkour` | Joins the magma row in the "pillar hops" checkpoint; coasting off the pad means lava, which means lost health. The recorded takeoff x=0.39963 is lost; the movement-controller landing-brake test covers it. |
| flat/pathfinder/soul-sand-lava-hop.yaml | pass | action-only | Cross one lava cell from a soul-sand lip to more soul sand (dig and scaffold false) with no damage, ending grounded above y -60.2 | pathfinder/movement-course (walking on soul sand only) | merge → `pathfinder/gauntlet-lava-parkour` | From EnderSeeker's 2026-09-08 death at -647,32,1. Unit: the native soul-sand crossing case in movement-controller.test.ts. |
| flat/pathfinder/soul-sand-parkour-detour.yaml | pass | white-box | No gap movement starts from soul sand; the supported north detour reaches the target |  | unit test: src/navigation/movements/catalogue.test.ts (exists) | Rows "a three-block gap from a short takeoff" and "a two-block gap from a short takeoff". A missed jump only falls 2 blocks onto bedrock, so there is no black-box signal. |
| flat/pathfinder/storage-detour.yaml | pass | action-only | navigate past a corridor blocked by a stocked chest and a table takes the long way; both blocks remain and the chest still holds 12 pearls and 79 gold | collect/exact-collection-preservation | retire-covered (`collect/exact-collection-preservation`) | Same barrier, chest contents, ceiling and diamond axe. The covering fixture adds return navigation and a use_container inspect of the exact slots. |
| flat/pathfinder/stranded-platform-descent.yaml | pass | action-only | From a floating platform one block thick, 8 above the ground, navigate to the ground fails with [NAVIGATION_STOPPED] and the bot stays up at full health |  | merge → `pathfinder/navigation-refusals` | single-action with expect {status: failed, errorContains: "[NAVIGATION_STOPPED]"}. Goals: health 20, plus reach at the platform centre with radius about 2.5 to prove the bot stayed up. Revisit if a water-bucket descent is ever supplied. |
| flat/pathfinder/surface-from-cave.yaml | pass | action-only | navigate with y omitted from inside a roofed cave is refused NAVIGATION_HEIGHT_REQUIRED without moving; an explicit y then digs and climbs onto the roof at 3,-54,0 |  | merge → `pathfinder/navigation-refusals` | A good opening stage: start in the cave, refuse, then climb out to the arena where the later refusals happen. |
| flat/pathfinder/tower-round-trip-canopy.yaml | pass | white-box | A mid-air goal 30 blocks up from under a birch canopy: the tower goes around the leaves and the bot climbs back down to its start unhurt |  | merge → `pathfinder/scaffold-course` | From the 1 Sept 2026 stranding. The driver called navigation.navigate because the action used to refuse mid-air targets; navigate build:true now expresses it. |
| flat/pathfinder/tower-round-trip-diagonal.yaml | pass | white-box | A mid-air goal 30 blocks up and 8,8 away: the tower is built, then descended back to the start unhurt |  | merge → `pathfinder/scaffold-course` | Same as the canopy row: navigate build:true, then navigate back to the start. |
| flat/pathfinder/tree-canopy-chest-handoff.yaml | pass | action-only | collect_block logs x6 climbs an oak into its canopy (scaffold allowed), then use_container inspects a ground chest on the far side; chest intact | collect/mixed-trees (tall trunks with dirt, but no handoff) | merge → `collect/mixed-trees` | Turn mixed-trees into a two-step sequence: the existing collect, then use_container inspect of a ground chest. The canopy-to-ground handoff is the added stage. |
| flat/pathfinder/twisting-vines-climb.yaml | pass | white-box | Climb twisting vines (plant and tip blocks) and exit onto a side landing despite an injected sideways velocity mid-column |  | merge → `pathfinder/climbing-course` | The impulse part goes to unit tests (see the vine-knockback-mid-climb row); the black-box course keeps the twisting-vine climb itself. |
| flat/pathfinder/vine-column-handoff.yaml | fail | white-box | Ride a vine column that ends mid-descent and transfer to the column one block over without any failed step. Arrival passes either way |  | unit test: src/navigation/execution/movement-controller.test.ts (new) | Run: behaviour: arrived, but a walk step failed during the column handoff. Uses the incident 97c795ac geometry. New case: a lateral step whose destination is the cell over a lower column completes when the body enters the column, not on a settled arrival. Optionally add an arrival-only leg to climbing-course. |
| flat/pathfinder/vine-free-hanging.yaml | pass | white-box | Climb a free-hanging vine under a leaf canopy and exit onto a side landing with no failed climb step | pathfinder/vine-chasm-parkour (free-hanging vine as a descent shortcut) | merge → `pathfinder/climbing-course` | A fall from the top is about 7 blocks, so the health goal replaces the failed-step check. |
| flat/pathfinder/vine-knockback-mid-climb.yaml | pass | white-box | A sideways velocity packet during a north-backed vine ascent: no step fails and the climb finishes unhurt |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Covered by "an upward vine climb cancels inherited sprint drift before the body leaves the column" and "a body that catches a vine in flight stops pushing and holds the column". Companion of the 2026-09-13 incident. |
| flat/pathfinder/vine-ledge-entry.yaml | pass | white-box | Run off a ledge into a vine column hanging past its lip and ride it 15 blocks down instead of crossing through it; full health | pathfinder/vine-chasm-parkour (related column-as-landing rule) | merge → `pathfinder/climbing-course` | Incident 97c795ac, 2026-09-13. Health is the whole discriminator (a 15-block fall). Unit: the column-landing case in catalogue.test.ts plus movement-controller.test.ts. |
| flat/pathfinder/vine-sprint-entry.yaml | pass | white-box | Sprint into a 10-high north-backed vine column and climb onto its top without drifting out of the open side; full health |  | merge → `pathfinder/climbing-course` | Incident 6e8aea78, 2026-09-13. The legacy floor was only 3 blocks below the drift point, so a drift cost no health; in the course, put the column over a deeper drop so a drift costs health. A unit test exists in movement-controller.test.ts. |
| flat/pathfinder/water-cross-current-low-ceiling.yaml | pass | action-only | Cross a diagonal flowing current under a two-block ceiling, one cell to 2,-58,0, without stalling; full health within 30s |  | merge → `pathfinder/water-course` | The legacy prepare hook waited 100 ticks for the flow, then teleported back. In a course the flow settles during setup, and a leg first walks to the start cell. |
| flat/pathfinder/water-cross-current.yaml | pass | action-only | Cross a shallow sideways current and return (range 0.1) without leaving the corridor; full health |  | merge → `pathfinder/water-course` | Two legs. |
| flat/pathfinder/water-current-channel.yaml | pass | action-only | In a shallow current channel, go downstream, then upstream, then climb onto a dry ledge; full health |  | merge → `pathfinder/water-course` | Three legs. |
| flat/pathfinder/water-deep-corner.yaml | pass | action-only | In a two-deep water passage, reach the corner, return, and exit onto a ledge without drowning; full health |  | merge → `pathfinder/water-course` | Three legs. The breath reflex is live in the runtime; under no-regen, health detects drowning. |
| flat/pathfinder/water-edge-search.yaml | pass | white-box | With the body overlapping level-7 flowing water beside air feet and head cells, a distant route still begins its first physical step |  | unit test: src/navigation/mineflayer/bot.test.ts (exists) | From EnderSeeker's live position. Pinned by "water touching the body is a swimming stance even when its feet and head cells are air". A course leg cannot reproduce the fractional start (y -58.94, z 0.7545). |
| flat/pathfinder/water-falling-corner.yaml | pass | action-only | Leave a two-deep falling current through its narrow sideways ledge, return to the current, and exit again; full health |  | merge → `pathfinder/water-course` | From seed 20260904's obsidian pickup holes. Three legs. |
| flat/pathfinder/water-falling-low-ceiling.yaml | pass | action-only | Swim out of a falling water column under a two-block exit ceiling to -2,-59,0 (0.4 radius) without stalling on head collisions; full health |  | merge → `pathfinder/water-course` | Reduced from EnderSeeker's westward swim at -862,-54,-472. The legacy start is y -58.4 inside the column; in the course, a leg enters the column first. |
| flat/pathfinder/weeping-vines-descent.yaml | pass | white-box | Enter a weeping-vine column from a side ledge and descend 8 blocks to the floor with no failed climb step and full health |  | merge → `pathfinder/climbing-course` | The setup-validation preflight is dropped. An 8-block fall would cost health, so the health goal replaces the failed-step check. |

### default/nether (40)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| default/nether/enderman-bypass-near.yaml | fail | action-only | First native hit lands on the near Enderman occluded behind a bedrock pillar rather than the distant visible one (damage_event packet attribution). |  | unit test: src/navigation/processes/hunting/hunt-process.test.ts (exists) | Run: stale: the driver could not observe its two declared endermen at start (arrangement drift). Ranking pinned by "enderman ranking keeps terrain priority inside a nearest-relative band..." and "...never promotes an explicit hazard tier". Verdict is which target is hit first: a tactic, not an outcome. Driver reads damage packets and runtime.status(). |
| default/nether/enderman-expedition-site.yaml | fail | white-box | At the recorded -5335131384818472281 site (-242,80,470) one of three clustered Endermen dies and the bot stays alive during a pearl hunt. |  | unit test: src/survival/control/combat/controller.enderman.test.ts (exists) | Run: stale: HUNT_NO_SHIELD: the hunt now refuses hostile quarry without a shield; the kit carries none. Injects createCombatController to watch roof_prepared refusals and uses bot.lookAt; roof refusal and defence are pinned by "a refused roof preserves defence against an angry enderman" and position.test.ts roof cases. Outcome (pearl hunt among grouped Endermen) also exercised by hunt/warped-forest-pearls. |
| default/nether/enderman-nylium-approach.yaml | pass | action-only | navigate approach (dig/scaffold off), collect_mob_drop 1 pearl among three native Endermen, navigate home: pearl gained, alive, at home. |  | merge → `hunt/warped-forest-pearls` | Seed 20260906 warped forest. Equipment via players[].equipment (driver wearArmor + server armour check go away). The nylium start (98.5,59,8.5) is dropped for the slope start on the same terrain. |
| default/nether/enderman-one-failed-approach.yaml | fail | action-only | After the primary Enderman is teleported onto a bedrock perch and back, the hunt still hits it first and records "closer target during approach". |  | unit test: src/navigation/processes/hunting/hunt-process.test.ts (exists) | Run: stale: the driver could not observe its two declared endermen at start (arrangement drift). Pinned by "one failed approach stops penalizing nearby quarry after it materially moves" and "reconsideration sees a closer alternative through one retained approach stop". Mid-run /tp of the target keyed on runtime.status() checkpoint cannot be expressed black-box. |
| default/nether/enderman-six-pearls-rate.yaml | pass | action-only | Six native pearls at >=1 pearl/min with a driver /summon replenisher, then return home alive. |  | merge → `hunt/warped-forest-pearls` | Replenisher becomes a YAML tick: "execute unless entity @e[type=enderman] run summon enderman 112.5 56 10.5 {PersistenceRequired:1b}". Rate check moves into the custom driver (time the hunt call) or the goal timeout. 192 cobblestone kept. |
| default/nether/enderman-six-pearls-slope-rate.yaml | pass | action-only | Same six-pearl rate hunt from the slope top (100.5,64,18.5), returning uphill. |  | merge → `hunt/warped-forest-pearls` | This is the arrangement the merged fixture keeps (start, Endermen, 192 cobblestone). |
| default/nether/enderman-slope-return.yaml | pass | action-only | One pearl from teleporting Endermen below the slope, then return uphill alive to (100,64,18). |  | merge → `hunt/warped-forest-pearls` | Strict subset of the six-pearl slope variant. |
| default/nether/enderman-teleport-away.yaml | pass | action-only | When the selected Enderman is teleported 40 blocks away the hunt switches to the nearer alternative (reason "selected target teleported") and hits it first. |  | unit test: src/navigation/processes/hunting/hunt-process.test.ts (exists) | Pinned by "a selected-target teleport stops its route and reports the distinct retarget reason". The trigger is a driver /tp on a runtime checkpoint, not expressible black-box. |
| default/nether/eyes-of-ender-collection.yaml | pass | action-only | Six rods at the run-14 spawner, then (after a driver teleport and arena fill) twelve pearls, then craft_item 12 ender_eye; 12 eyes in inventory, alive. |  | merge → `hunt/fortress-spawner-rods` | Driver teleports, fills an arena and summons mid-run: not black-box. Keep the craft tree by supplying 12 pearls in the kit and appending craft_item ender_eye x12 after the rod hunt; pearl hunting itself is covered by hunt/warped-forest-pearls. |
| default/nether/fortress-bridge-rod-and-exit.yaml | fail | action-only | One blaze rod under blazes on both sides of the lower bridge (-36.5,79,357.5), then navigate west exit (-39.5,79,357.5), alive. |  | merge → `hunt/fortress-rod-and-exit` | Run: stale: HUNT_NO_SHIELD: no shield in the kit. Add its two bridge blazes (-32.5,81,357.5 and -40.5,81,357.5) to the merged arrangement so the crossfire stays. |
| default/nether/fortress-crossfire-cover.yaml | fail | white-box | Calls hideInPlace directly after the first blaze shot; no blaze hit after cover and health >=18 after 20 s, no shield. |  | merge → `combat/fortress-wounded` | Run: behaviour: cover held but health ended 14.9, under the 18 required. Black-box form: idle driver (waitForTicks ~600) with five blazes summoned live at start, kit without shield or bow; goals survive + health >=18 (regen on, as now). Drop the hide-specific assertion; any response that keeps health is fine. |
| default/nether/fortress-expedition-kit.yaml | fail | action-only | Twelve rods (no camping, golden boots, 2 shields, 128 cobblestone) at the run-14 spawner, alive. |  | merge → `hunt/fortress-spawner-rods` | Run: behaviour: 12 rods at 0.13 per minute; the hunt did not finish within its window. 2026-09-07 live death at this spawner. Merged fixture uses this kit (smaller cobblestone budget) with the twelve-rod camp request. |
| default/nether/fortress-pair-rod-and-exit.yaml | fail | action-only | One rod with the upper spawner disabled, return to (-27.5,82,350.5), alive. |  | merge → `hunt/fortress-rod-and-exit` | Run: stale: HUNT_NO_SHIELD: no shield in the kit. Near-duplicate of fortress-rod-and-exit (start 1 block apart) with the spawner switched off; the live-spawner version is the stricter superset. |
| default/nether/fortress-rod-and-exit.yaml | fail | action-only | collect_mob_drop blaze_rod 1 then navigate exit (-27.5,82,350.5): rod, alive, in range of exit. |  | merge → `hunt/fortress-rod-and-exit` | Run: stale: HUNT_NO_SHIELD: no shield in the kit. Base arrangement of the merged fixture (spawner live). Equipment via YAML. |
| default/nether/fortress-six-rods-rate.yaml | fail | action-only | Six rods at >=1 rod/min at the run-14 spawner, alive. |  | merge → `hunt/fortress-spawner-rods` | Run: behaviour: hunt returned unsuccessful after 1 rod (minimum health 11.3). Rate folds into the merged twelve-rod request (driver-timed >=1/min). |
| default/nether/fortress-sortie.yaml | pass | action-only | Seed 20260906 fortress: hunt 1 rod past a wither-skeleton bystander, return to (-452,60,270), 5 s dwell, alive. |  | merge → `hunt/fortress-rod-and-exit` | Fold the wither-skeleton bystander into the -5335131384818472281 room; the 20260906 stair-room geometry is dropped. |
| default/nether/fortress-twelve-rods.yaml | fail | action-only | Twelve rods with camp_spawner and observe_for_ms 45000 at >=1 rod/min, alive. |  | merge → `hunt/fortress-spawner-rods` | Run: behaviour: 12 rods at 0.27 per minute, under the 1 per minute floor. 2026-09-07 run-14 death site. Driver armour command check becomes equipment; driver rate check stays (custom driver timing one call). |
| default/nether/fortress-withdrawal.yaml | fail | action-only | At 11 health without regen, navigate to the far western exit (-490,60,270) under blaze + wither-skeleton pressure; arrive alive. |  | merge → `combat/fortress-wounded` | Run: behaviour: evade ended in capability_limit 49 blocks out; never reached the exit. Single-action navigate; health: 11 and regen off in YAML; goals reach/survive/health/completion as now. The exit was moved west because returning to -452 re-entered blaze range (live evade). |
| default/nether/gravel-overhang-mining.yaml | pass | action-only | collect nether_gold_ore at (88,38,-21) from the recorded tunnel without stepping onto naturally suspended gravel over lava: success or NO_REACHABLE refusal, health 20, no lava. | collect/coal-under-sand (partly) | migrate → `collect/nether-gravel-overhang` | Suspended gravel only exists from generation (seed 5831896158372390619), so it cannot join a flat fixture. Driver must accept succeeded or failed with [NO_REACHABLE_MATCHING_TARGETS] (single-action expects one status; pick the current outcome). Unit cover exists: catalogue.test.ts "walking and downward excavation reject suspended gravel", excavation.test.ts. |
| default/nether/hazards/basalt-crossfire-melee.yaml | fail | action-only | Same 36-block basalt traverse without a bow: arrive alive, no lava/magma, never strike a neutral Enderman first. |  | delete: kit variation of basalt-crossfire; weapon choice is implementation | Run: stale: driver's result schema expects outcome.response, which the runtime no longer reports. The merged traverse keeps the same mobs and goal; which weapon answers the ghast is a tactic. |
| default/nether/hazards/basalt-crossfire-provoked.yaml | fail | white-box | At 11 health the driver gazes (bot.lookAt) to provoke an Enderman, then navigates the traverse alive. |  | merge → `combat/basalt-crossfire-traverse` | Run: stale: driver's result schema expects outcome.response, which the runtime no longer reports. Provocation becomes YAML: a tagged Enderman with AngerTime/AngryAt set by a guarded tick (data modify ... AngryAt set from entity @a[name=...] UUID), so no body control is needed. |
| default/nether/hazards/basalt-crossfire.yaml | fail | action-only | navigate (36,101,0) across a built basalt arena over lava under magma cubes, Enderman and ghast: arrive, alive, no lava/magma, neutral Enderman not hit first, all mob types seen. |  | merge → `combat/basalt-crossfire-traverse` | Run: stale: driver's result schema expects outcome.response, which the runtime no longer reports. Base arena. "Not hit first" becomes an outcome: a second, neutral Enderman must still be alive (entityCount enderman min 1). Lava/magma contact shows as health loss once regen is off. |
| default/nether/hazards/canopy-gap-hunt.yaml | fail | action-only | Hunt the Enderman across a generated canopy gap with a 10-block drop, return to refuge (102,65,-15): pearl, alive, no lava, no unsupported descent >3. |  | merge → `hunt/warped-forest-pearls` | Run: behaviour: pearl gained but the return to the refuge stopped 1.1 blocks short. First stage of the merged sequence (start 104.5,64,-11.5, canopy Enderman nearest). The <=3-block descent check is lost (driver tick sampling); falls still cost health. |
| default/nether/hazards/generated-basalt-combat-handoff.yaml | pass | white-box | Builds a ScenarioCombat controller, injects a recorded cube impulse and kills the target mid-hop: lands on safe support within 3 blocks at full health. |  | unit test: src/navigation/steering/supported-position.test.ts (exists) | Pinned by "finishing combat retains correction until an airborne body lands safely" and "a route that stops airborne hands back its latest observed support". Velocity injection is not black-box. |
| default/nether/hazards/generated-basalt-combat-knockback.yaml | pass | white-box | Drives SupportedPositionHold directly with two recorded cube impulses on the basalt ledge: no lava, y >=33, grounded. |  | unit test: src/navigation/steering/supported-position.test.ts (exists) | Pinned by "combat holds the supporting cell through a knockback hop without changing shield facing". |
| default/nether/hazards/generated-basalt-drop-cancel.yaml | pass | white-box | Cancels context.navigation mid-drop off a basalt ledge; must stop grounded at full health, no lava/magma. |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Pinned by "cancelling a drop retains its steering until the descending body has supported ground". Black-box has no cancellation. |
| default/nether/hazards/generated-basalt-gap-cancel.yaml | fail | white-box | Cancels context.navigation at the launch lip (x>=200.05): momentum must not carry the bot into lava. |  | unit test: src/navigation/execution/movement-controller.test.ts (exists) | Run: stale: no path from the declared start (visited 1 node): the recorded generated gap no longer matches. Pinned by "cancelling before the movement tick at a launch lip retains the jump instead of coasting into lava". |
| default/nether/hazards/generated-basalt-gap.yaml | fail | white-box | context.navigation crosses the generated basalt gap (199.5,49,-16.5 to 203,49,-17) at full health, no magma contact. |  | merge → `pathfinder/basalt-deltas-traverse` | Run: stale: no path from the declared start (visited 1 node): the recorded generated gap no longer matches. Black-box as a navigate-route checkpoint; regen off so magma/lava contact shows as health loss. |
| default/nether/hazards/generated-basalt-hunt-melee.yaml | fail | action-only | Magma-cream hunt without a bow across basalt ledges, return to shelf: cream, alive, no lava/magma. |  | merge → `hunt/basalt-magma-cream` | Run: behaviour: cream gained and returned, but the bot touched lava. Kit variant; merged fixture uses the melee-only iron kit. |
| default/nether/hazards/generated-basalt-hunt.yaml | fail | action-only | collect_mob_drop magma_cream 1 from a Size-3 and Size-1 cube, navigate back to (185,49,-19): cream, at start, alive, no lava/magma. |  | merge → `hunt/basalt-magma-cream` | Run: behaviour: 10 cubes killed, no cream gained (partial). Base sequence. Driver's biome and body-clearance survey checks drop (generation is seeded). |
| default/nether/hazards/generated-basalt-islands-hunt.yaml | pass | action-only | Hunt two medium cubes on small islands by the lava ocean (184.5,35,-33.5) and return: cream, alive. |  | merge → `hunt/basalt-magma-cream` | Becomes the second stage: navigate to the islands, collect_mob_drop again, final goal cream x2. |
| default/nether/hazards/generated-basalt-knockback-drop.yaml | pass | white-box | Injects the recorded cube impulse during a cancelled context.navigation descent: keeps the first safe ledge (y>=47). |  | unit test: src/navigation/execution/route-executor.test.ts (exists) | Pinned by "a cancelled landing brakes knockback before it carries the bot off its new ledge". |
| default/nether/hazards/generated-basalt-large-cube-hunt.yaml | pass | action-only | Hunt one large cube and its splits on the shelf, return with cream, alive. |  | merge → `hunt/basalt-magma-cream` | Subset of the pack arrangement. |
| default/nether/hazards/generated-basalt-lower_ledge.yaml | pass | action-only | navigate from (198.5,49,-18.5) to (185,49,-20) past a Size-0 cube on a ledge 5 below: arrive alive, no lava/magma, journey not turned into a hunt. |  | merge → `pathfinder/basalt-deltas-traverse` | Keep the lower-ledge cube as an entity for the whole course; the return checkpoint to (185,49,-20) passes it. |
| default/nether/hazards/generated-basalt-magma-gap.yaml | pass | white-box | context.navigation from the pack-retreat stance (199.36,48,-19.225) to (199,49,-18) at full health without magma contact. |  | merge → `pathfinder/basalt-deltas-traverse` | Checkpoint of the course. |
| default/nether/hazards/generated-basalt-pack-contact.yaml | fail | action-only | Hunt starting 3 blocks from two large cubes (first melee contact), return with cream, alive. |  | merge → `hunt/basalt-magma-cream` | Run: behaviour: 15 cubes killed, no cream gained, magma contact. Start-distance variant of pack-hunt; the merged fixture keeps the farther start. |
| default/nether/hazards/generated-basalt-pack-hunt.yaml | fail | action-only | Iron melee hunter vs two large cubes and splits on the shelf, return with cream, alive. |  | merge → `hunt/basalt-magma-cream` | Run: behaviour: 31 cubes killed, no cream gained (partial). Arrangement the merged fixture keeps (hardest). |
| default/nether/hazards/generated-basalt-wounded.yaml | pass | action-only | Idle 20 s at 11 health, regen off, beside two large cubes: alive, no lava/magma. |  | merge → `survival/nether-idle-survival` | One of two players in the merged idle fixture (DeltaBot). |
| default/nether/hazards/wounded-cliff.yaml | pass | white-box | At 11 health, regen off, beside a 14-block cliff, the driver gazes to anger an Enderman then idles 60 s: alive, grounded, no lava, no unsupported descent >3. |  | merge → `survival/nether-idle-survival` | Second player (CliffBot). Anger via guarded tick (AngryAt from the player's UUID + AngerTime) instead of bot.lookAt. |
| default/nether/netherrack-loaded-scan.yaml | fail | action-only | 32 netherrack from a controlled bank inside native Nether terrain with no physics-tick gap >=1 s (live request 124, 2026-09-08). | collect/netherrack-bank (flat twin) | merge → `collect/netherrack-bank` | Run: behaviour: no stall (the guarded regression holds) but collection ended 31/32 with DROP_RECOVERY_EXHAUSTED. Move the bank into world.dimension the_nether (seed -5335131384818472281, coordinates y 60-67) so the dense native netherrack scan runs during collection; the physics-gap timing is not observable black-box and is pinned by src/world/loaded-block-scan.test.ts (exists). |

### default/end (14)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| default/end/bucket-native-knockback.yaml | pass | action-only | A TNT blast knocks the bot off a 41-block End platform; it must survive (fall alone is lethal) and end holding a refilled water bucket. |  | migrate → `survival/end-knockback-water-landing` | prepare hook = kill dragon and endermen, fill 65..100,58..115,-16..16 air with an end_stone floor at y58, glass at (76,99,0) and (79,99,0), tp to (79.5,100,0.5). All YAML: geometry fills/setblocks, players[].pos (79.5,100,0.5), equipment, tick "kill @e[type=ender_dragon]" (or doMobSpawning false + kill once via guarded tick), entities: tnt at (76.5,100,0.5) nbt {fuse:20}. Idle driver waits 200 ticks; goals survive + hasItem water_bucket. Unit cover: src/navigation/mineflayer/water-landing.test.ts. |
| default/end/claude-first-entry.yaml | timeout | action-only | Recorded 2026-09-13 first-fight loadout (40 slots with durability, no arrows): set defend_only policy, drop junk in a hole, melee every crystal with end-stone resupply, then perch fight; dragon killed. |  | merge → `combat/ender-dragon-fight` | Run: timeout: dragon still alive after 40 minutes. prepare hook = restoreRecordedLoadout (item replace per slot with minecraft:damage) + health/ground check. YAML: guarded tick block "execute as @a[name=DragonFighter,tag=!loaded] run item replace entity @s <slot> with minecraft:<item>[minecraft:damage=N] <count>" x40, then "tag @a[name=DragonFighter] add loaded" (same tick function, runs once at start). Driver: view_status, set_survival_policy, drop_item, collect_block/navigate resupply, destroy_end_crystal melee, prepare/attack perch - all registered actions. |
| default/end/crystals-bow.yaml | pass | action-only | Explicit weapon:bow destroys all ten crystals including both caged ones; zero crystals remain. |  | merge → `combat/end-crystals-every-method` | prepare hook (ender-dragon.ts) = wear armour + wait for 10 native crystals; no world change. YAML: equipment; driver asserts 10 crystals via view_status. Merged fixture assigns bow to one caged and the exposed remainder. |
| default/end/crystals-melee-pillar.yaml | pass | action-only | Melee approach pillar (end_stone only, no cobblestone) destroys all ten crystals without mining obsidian; zero crystals remain. |  | merge → `combat/end-crystals-every-method` | Same prepare as crystals-bow (armour + crystal count only). Merged fixture assigns pillar to the lowest exposed towers. |
| default/end/crystals-melee.yaml | pass | action-only | Melee approach staircase destroys all ten crystals; zero crystals remain. |  | merge → `combat/end-crystals-every-method` | Same prepare. Merged fixture assigns staircase to one caged tower and two exposed ones. |
| default/end/crystals-mixed.yaml | pass | action-only | Bow on exposed crystals, then melee on caged ones; zero crystals remain. |  | merge → `combat/ender-dragon-fight` | Identical to the crystal half of ender-dragon.yaml; the fight's goal list adds entityCount end_crystal max 0. |
| default/end/dragon-bow.yaml | timeout | action-only | With crystals removed, repeated shoot_dragon calls (hitbox_margin 0.5) kill the flying dragon; navigate back to start when DRAGON_SHOT_BLOCKED; dragon killed, alive. |  | migrate → `combat/ender-dragon-bow` | Run: timeout: dragon still alive after 20 minutes. prepare hook = armour + wait for 10 crystals + "kill @e[type=end_crystal]" and wait until gone. YAML: equipment + tick "kill @e[type=end_crystal]" (runs every tick from start; crystals never respawn in this fight). Driver waits ~20 ticks and confirms zero crystals via view_status before shooting. |
| default/end/dragon-perch.yaml | fail | action-only | With crystals removed, prepare/attack perch loop kills the full-health dragon; alive. |  | merge → `combat/ender-dragon-fight` | Run: harness: dragon killed; the legacy `survive` goal never settled after completion. Same zero-crystal prepare as dragon-bow (tick kill expresses it). Covered by the perch half of the full fight, which starts from the same zero-crystal state after the bot clears them. |
| default/end/dragon-post-crystal-replay.yaml | pass | action-only | Seed 64510673 replay of a retained death: zero crystals, dragon at 190 health, worn/damaged recorded kit at (-28.5,62,35.5); perch loop kills the dragon. |  | migrate → `combat/ender-dragon-post-crystal-replay` | prepare hook = ender-dragon prepare (armour, kill crystals) + "data merge entity @e[type=ender_dragon,limit=1] {Health:190.0f}" + restoreRecordedLoadout (7 slots with damage). YAML: tick "kill @e[type=end_crystal]"; guarded tick "execute as @e[type=ender_dragon,tag=!replay] run data merge entity @s {Health:190.0f,Tags:["replay"]}"; guarded item replace block for the 7 slots. Driver checks dragon health 190 via view_status before the first call. |
| default/end/ender-dragon.yaml | pass | action-only | Mixed crystal clearing then perch loop: dragon killed, survive. |  | merge → `combat/ender-dragon-fight` | Base of the merged fight. prepare = armour + 10-crystal wait only (phase full kills nothing): YAML equipment, no hook needed. |
| default/end/first-entry-64510673.yaml | timeout | action-only | First-entry loadout and caller on seed 64510673 from (12.5,65,0.5); dragon killed. |  | delete: seed variant of combat/ender-dragon-first-entry | Run: timeout: dragon still alive after 40 minutes. Same caller and loadout; the recorded seed 81360492 is kept. |
| default/end/first-entry-8675309.yaml | timeout | action-only | First-entry loadout and caller on seed 8675309 from (12.5,64,0.5); dragon killed. |  | delete: seed variant of combat/ender-dragon-first-entry | Run: timeout: dragon still alive after 40 minutes. Seed 8675309 terrain stays exercised by the crystal and fight fixtures. |
| default/end/landing-idle-escape.yaml | pass | action-only | Recorded idle-bot death (seed 64510673): a curving landing dragon released beside a breath cloud; idle runtime must avoid landing contact, keep health >=12, see the dragon settle, end out of danger. |  | migrate → `survival/dragon-landing-idle-escape` | prepare hook = armour; dragon NoAI DragonPhase 3 at (6.356,77.418,-3.975) Rotation [-95.625f,0f]; kill endermen; kill all crystals except (33.5,80,-24.5) and (-33.5,83,-24.5); summon dragon_breath area_effect_cloud at (-0.770,65,11.637); tp bot to (-1.5005,65,3.5411); run releases AI with Motion [-0.0435,-0.146,0.010875]. YAML: players[].pos fractional; entities: the area_effect_cloud; tick "execute as @e[type=end_crystal] unless entity @s[x=33.5,y=80,z=-24.5,distance=..1] unless entity @s[x=-33.5,y=83,z=-24.5,distance=..1] run kill @s"; guarded tick "execute as @e[type=ender_dragon,tag=!staged] run data merge entity @s {DragonPhase:3,Pos:[...],Motion:[-0.0435d,-0.146d,0.010875d],Rotation:[-95.625f,0f],Tags:["staged"]}" (staging and release collapse into the first tick). Idle driver polls view_status to confirm a landing/sitting phase; goals survive + health >=12. Unit: end-fight.test.ts "a turning landing keeps the observed fountain unsafe until touchdown" (exists). |
| default/end/perch-enderman.yaml | pass | action-only | A pending attack_dragon_perch (dragon held hovering) is interrupted by an angry Enderman: the reflex kills it and resumes the same request; Enderman dead, bot alive. |  | migrate → `combat/dragon-perch-enderman-contact` | prepare hook = ender-dragon prepare, kill endermen, data merge dragon {DragonPhase:10,Pos:[0,120,0],Motion:[0,0,0]}, summon NoAI Enderman 3 blocks south; run releases it with AngerTime 600 + AngryAt = bot UUID after the action is admitted. YAML: guarded tick for the dragon hover; entity summoned NoAI and released by a scoreboard timer tick (~40 ticks) with AngryAt set from the player's UUID. Black-box verdict: goals entityCount enderman max 0 + survive WITHOUT completion (the driver cannot cancel the waiting perch); "resumed same request" check is lost. |

### flat/collect, bucket, flowing-lava, explore, hunt, survival, water (123)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| flat/bucket/fill-planted-shore-approach.yaml | pass | action-only | From outside reach, two water fills succeed from a higher bank without using submerged seagrass as a stance. |  | merge → `bucket/water-sources-course` | Run 17. First stage of the course; start outside reach. |
| flat/bucket/fill-planted-shore.yaml | pass | action-only | Two water fills from a bank two cells above water succeed without treating seagrass as dry ground. | bucket/water-sources-course | merge → `bucket/water-sources-course` | Redundant with the approach variant once that starts the course; both fold into one stage. |
| flat/bucket/fill-sealed-pocket.yaml | pass | action-only | Fill at a fully enclosed underground source digs access and fills from dry ground. |  | merge → `bucket/water-sources-course` | Exact-coordinate fill stage. |
| flat/bucket/obsidian-from-deep-water.yaml | pass | action-only | Fill from a 4-deep pool without standing in it, pour on lava, refill, then collect obsidian 3. | bucket/fill-flowing (fill only) | merge → `bucket/water-sources-course` | Drowning incidents in playthroughs. Add a no-regen health 20 goal so a fill from the pool bottom fails. |
| flat/bucket/obsidian-from-lava.yaml | pass | action-only | Fill, pour onto a lava pool shore, refill from the poured cell, collect obsidian 3. | collect/cast-obsidian, collect/obsidian-in-rock (cast via collect) | merge → `bucket/water-sources-course` | Explicit use_bucket pour/refill contract, distinct from collect's cast. Drain wait (6 s) becomes waitForTicks or collect's own water handling. |
| flat/bucket/portal-frame-and-crossing.yaml | pass | action-only | Build a portal from exactly 10 obsidian + 4 cobble, light it, refuse low-supply entry without moving, cross to the Nether, refuse immediate return, then return. | build/portals-through-leaves (frames only) | migrate → `portal/nether-round-trip` | Needs a custom driver: return-portal cells are found at run time (view_blocks), and the 220-tick cooldown is waitForTicks. Per-step expect for PORTAL_LOW_SUPPLIES / PORTAL_ALREADY_INSIDE. |
| flat/bucket/pour-through-lava.yaml | pass | white-box | Vanilla probe: a full bucket aimed through lava at the floor lands water in the lava cell, forms an obsidian ring, and can be scooped back. |  | delete: Vanilla dependency probe; pourAim is unit-tested and casts are exercised | use-bucket.test.ts 'pour aims where the ray actually lands in the named cell' exists; collect/cast-obsidian and obsidian-in-rock depend on the same fact. Driver equips and aims the body itself. |
| flat/collect/clay-shore.yaml | pass | action-only | Bare-handed collect clay 8 from a riverbank with water just beyond the patch yields 8 clay_ball. | collect/mixed-resource-site (clay with iron shovel, partial) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a bare-hand case. Collect clay before the wooden shovel is crafted so it stays bare-handed; goal clay_ball 8. |
| flat/collect/coal-outcrop.yaml | pass | action-only | Stone-pickaxe collect coal_ore 5 from the lower face of a stone hillside yields 5 coal. | collect/mixed-resource-site (iron pickaxe), progression primitive (coal 4 with stone pickaxe) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a stone-pickaxe case. Use the outcrop geometry as the progression's coal source; raise the coal request to 5. |
| flat/collect/cobweb-overhead.yaml | pass | white-box | Sword collect of an overhead cobweb yields string and clears the cell; driver aborts if a committed excavation step plans no break. |  | merge → `collect/mixed-resource-site` | Add iron_sword and an overhead cobweb to the site; step collect cobweb 1; goals string 1 + blockAt air. The empty-excavation loop then fails by timeout, without subscribing to pathfinder events. |
| flat/collect/copper-slope.yaml | pass | action-only | Stone-pickaxe collect copper_ore 8 from a stepped slope yields 8 raw_copper. | collect/mixed-resource-site (iron pickaxe, 4 copper) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a stone-pickaxe case. Collect it with the crafted stone pickaxe before the iron pickaxe exists; goal raw_copper 8. |
| flat/collect/deep-diamond-descent.yaml | pass | action-only | Collect diamond_ore 3 at the bottom of a 52-block solid hill with no damage (no regen, health 20, zero damage packets). |  | migrate → `collect/deep-diamond-descent` | single-action collect diamond_ore 3; template flat-single-action-no-regen with a reset covering y -59..-6; goals diamond 3 + health 20. The damage-packet counter is implied by the health goal. |
| flat/collect/dirt-terrace.yaml | pass | action-only | Bare-handed collect dirt 8 from a two-level terrace yields 8 dirt. | collect/mixed-resource-site (dirt with iron shovel, 4) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a bare-hand case. Collect before the wooden shovel is crafted; replaces the progression's 2-dirt patch; goal dirt 8. |
| flat/collect/door-replace-after-pickup.yaml | pass | action-only | After collecting a birch door, a place_block of the door succeeds while the bot occupies the doorway; both halves present. | collect/exact-collection-preservation (door collection only) | merge → `collect/exact-collection-preservation` | Append steps: navigate into the collected doorway (range 0) and place_block birch_door there. Change the door goals from air to birch_door at the target; the nearer door and oak door goals still catch a wrong target. Driver's conditional navigate becomes unconditional. |
| flat/collect/dripstone-hanging-support-collect.yaml | pass | action-only | Exact collect of the stone holding a stalactite above the bot is refused with NO_REACHABLE_MATCHING_TARGETS; no damage; support and tip intact. |  | merge → `pathfinder/dripstone-stances` | single-action expect failed errorContains NO_REACHABLE_MATCHING_TARGETS; no-regen world; goals health 20, blockAt stone (0,-54,0) and pointed_dripstone (0,-55,0). Truthful-refusal fixture. |
| flat/collect/dripstone-tip-collect.yaml | pass | action-only | Starting settled on an upward pointed_dripstone tip, an exact stone collect succeeds without damage. | pathfinder/cave-excavation-course (walks over tips, never starts on one) | merge → `pathfinder/dripstone-stances` | Legacy prepare hook teleports onto the tip. Use players[].pos [0.5,-57,0.5] if Mine Labs lands it on the tip (see harness gaps). Incident: reliability-plan note that the bot stood on dripstone where no action could act. |
| flat/collect/dry-mining-aquifer-roof.yaml | pass | action-only | Collect stone 1 takes the dry alternative rather than the roof over a water pocket; roof intact, health 20, under 45 s. |  | merge → `collect/wet-mining-site` | Use a block type unique to this sub-site (for example deepslate roof and dry deepslate) so other stone in the merged world cannot satisfy it; goal blockAt roof + hasItem. Run it first so the bot starts on the roof. |
| flat/collect/dry-mining-water-wall.yaml | pass | action-only | Collect stone 1 beside a water source by sealing it; dry work area; health 20; under 45 s. |  | merge → `collect/wet-mining-site` | Exact-coordinate collect in the merged world; goal: the sealed source cell is no longer water (blockAt) plus cobblestone count. The 'never wet' flag was driver-only; express it as the seal goal. |
| flat/collect/fallen-oak.yaml | pass | action-only | Bare-handed collect logs 6 along a fallen oak whose crown blocks its far end yields 6 oak_log. | collect/mixed-trees (fallen spruce with axe and dirt) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a bare-hand case. Make the fallen oak the progression's first log source (bare hands, 6 logs). |
| flat/collect/flowing-water-tree-approach.yaml | pass | action-only | Collect 6 logs beside a waterfall from the north bank, isolating level-four flow with carried dirt. |  | merge → `collect/waterfall-oak` | Its setup columns produce the live incident's level-four flow; use this geometry for the merged world. Legacy prepare waited 100 ticks then teleported (see harness gaps). |
| flat/collect/flowing-water-tree-no-material.yaml | pass | action-only | With no dirt, collect logs 6 returns partial 'liquid isolation needs' after some logs, health 20, near the tree, under 45 s. |  | merge → `collect/waterfall-oak` | First step of the merged sequence with expect partial errorContains 'liquid isolation needs'; then collect dirt from the bank, then finish the logs. |
| flat/collect/flowing-water-tree.yaml | pass | action-only | Barehanded collect of all six logs of an oak beside a waterfall (live site geometry) with carried dirt; oak_log 6 within 120 s. |  | merge → `collect/waterfall-oak` | Live incident: multi-minute stall at a waterfall oak. Final goal oak_log 6, health 20 (no regen), completion. |
| flat/collect/iron-seam.yaml | pass | action-only | Stone-pickaxe collect iron_ore 5 from a five-block seam in a rough cut yields 5 raw_iron. | collect/mixed-resource-site (iron pickaxe), progression primitive (rawIron 3) | merge → `progression/tool-tier-progression` | Kept by 2db0f41 as a stone-pickaxe case. Use the seam as the progression's iron source; request 5 (smelt 3, keep 2 or smelt all). |
| flat/collect/lava-escape-to-water.yaml | fail | action-only | Starting in a one-cell lava pocket with no request, the runtime's fire reflex climbs out and extinguishes in nearby water; survives. |  | merge → `survival/fire-reflex` | Run: harness: escaped unhurt; the legacy `survive` goal never settled after completion. Idle first stage: driver waitForTicks then view_status not burning; survive goal. Player starts in the lava cell (pos), no prepare needed. |
| flat/collect/lava-interrupts-mining.yaml | fail | action-only | Lava placed in the bot's cell during an obsidian dig interrupts the dig and the bot escapes to water; survives. |  | merge → `survival/fire-reflex` | Run: behaviour: escaped lava but ended at 1 health. Driver injected lava with /setblock on first dig tick. Use a one-shot tick trigger (scoreboard flag + execute if entity at the dig stance) to place lava; goals survive + completion. |
| flat/collect/loaded-oak-outside-radius.yaml | pass | white-box | Collect oak_log 1 picks a loaded oak 70 blocks away without branch exploration, then an exact collect at 140 blocks succeeds. |  | merge → `collect/mixed-trees` | Append two steps to mixed-trees (switch it to action-sequence): collect oak_log 1, then exact oak at (140,-59,0); goal oak_log 9 within a timeout that exploration would exceed. Unit test 'an exact target remains available beyond the general scan's nearest-match limit' already in mine-process.test.ts. Reset must cover x 140. |
| flat/collect/netherrack-loaded-scan-control.yaml | fail | action-only | Overworld control for the Nether loaded-scan stall regression: collect netherrack 32 with no physics gap over 1 s. |  | delete: Diagnostic control run for default/nether/netherrack-loaded-scan; not a guarantee | Run: stale: declares no absolute player position, which Mine Labs now requires. Also has no geometry or pos, so the bank its driver checks at y 60 is never built. The Nether fixture owns the regression. |
| flat/collect/obsidian-by-exploring.yaml | pass | action-only | With lava only 80 blocks out on four sides, collect obsidian 3 explores, casts, mines 3, recovers the bucket, no death. | collect/obsidian-by-exploring (same world, count 2) | merge → `collect/obsidian-by-exploring` | Same world, inventory and goals except count 3 vs 2. Raise the tests/minecraft request and goal to 3, then delete this one. |
| flat/collect/obsidian-cast-from-far-lava.yaml | pass | action-only | Collect obsidian 3 walks 60 blocks to the only scanned lava, pours, recovers the bucket and mines 3. | collect/obsidian-by-exploring (ends with the same walk-pour-recover) | delete: Subsumed by collect/obsidian-by-exploring's final leg | The only difference is skipping the branch walk; the walk-to-scanned-lava cast is exercised there. |
| flat/collect/obsidian-drain-before-mining.yaml | pass | action-only | With no bucket, obsidian covered by water and beside lava is collected after plugging the water; health 20. | collect/obsidian-scoop-before-mining (same geometry WITH a bucket), collect/obsidian-hazards (water and lava on separate targets) | merge → `collect/obsidian-hazards` | Add as a fourth site: water and lava on the same target with no bucket; blocksAt air at that target. |
| flat/collect/obsidian-in-rock.yaml | pass | action-only | Collect obsidian 3 from a 5x5 lava pool sealed under a stone lid: open a pour cell, cast, recover the bucket, mine 3. | collect/obsidian-in-rock (single buried source + exact six-block budget) | delete: Stricter single-buried-source case in tests/minecraft obsidian-in-rock | Judgment call: 2db0f41 kept it as a 'larger pool'. The 25-source pool only makes the count easier; the per-second census driver was diagnostic only. |
| flat/collect/obsidian-lake.yaml | pass | action-only | Collect obsidian 10 from a ring around a lava lake (every target has a lava face), cobblestone carried; no death. | collect/obsidian-hazards (one lava-faced block) | merge → `collect/obsidian-hazards` | Run 10: 107 loaded obsidian mined none. Add the ringed lake as a site; total request rises so the ring must supply about 10. |
| flat/collect/obsidian-six-sources.yaml | pass | action-only | Six level lava sources, no carried blocks: collect obsidian 6 exactly with the water bucket recovered within 180 s. | collect/obsidian-in-rock (exact six budget, but carries 32 cobblestone) | merge → `collect/obsidian-in-rock` | Lost today: the exact budget without carried building blocks. Add the level 3x2 pool as a second exposed site, request 12, and drop the carried cobblestone (or keep a variant without it). |
| flat/collect/obsidian-under-water.yaml | pass | action-only | Collect obsidian 6 from a cast slab with a water source on top flowing over it; isolate the flow; no death. | collect/obsidian-hazards (flowing water above one block, source two cells away) | merge → `collect/obsidian-hazards` | Run 10 third link. Add the slab with the source on its centre; require blockAt air under the source cell. |
| flat/collect/preserve-collected-water-plug.yaml | pass | action-only | Exact log under flowing water is collected using carried dirt, not carried logs, as the plug (oak_log 64 -> 65). |  | merge → `collect/wet-mining-site` | hasItem oak_log 65 alone catches a log spent as a plug. Legacy prepare waited 100 ticks for flow then teleported; place the settled flow or wait in driver. |
| flat/collect/request-resumption.yaml | pass | white-box | Fixture claim pauses collection after the first coal and navigation after 3 blocks; both resume with count 2 / blocksBroken 2 and the original route start. | combat/busy-dig-interrupted (collection resumes after a real hostile takeover) | unit test: src/actions/navigate/navigate.test.ts (exists) | 'resumed navigation retains the request origin' exists; resume mechanics in src/session/action-runner.test.ts (exists). The fixture_reflex claim is a simulated reflex. |
| flat/collect/same-state-storage.yaml | pass | action-only | Exact chest collection beyond a same-state stocked chest leaves it intact (12 pearls, 79 gold) and returns. | collect/exact-collection-preservation (same barrier, stricter slot check) | merge → `collect/exact-collection-preservation` | Only difference: legacy walls run z -20..15, making a break-through far cheaper than the detour. Lengthen the bedrock walls in the consolidated fixture, then delete. |
| flat/collect/stone-from-water.yaml | pass | action-only | Exact wet stone face collected from a floating stance without 20 empty arrivals. |  | merge → `collect/wet-mining-site` | The 20-arrival abort was a diagnostic stop; the timeout and cobblestone goal express the outcome. |
| flat/collect/stone-in-flowing-water.yaml | pass | action-only | Collect stone 3 from a stream bed starting in the current, isolating the flow; health 20; under 45 s. |  | merge → `collect/wet-mining-site` | Starting in the current is lost when it is not the first stage; the bot enters the stream itself. |
| flat/collect/tool-loss-policy.yaml | pass | action-only | Near-broken diamond pickaxe: default stop returns TOOL_TIER_LOST, on_tool_loss continue finishes with stone pickaxe, last-tool loss is explicit. |  | unit test: src/world/tool-loss.test.ts (exists) + src/actions/collect-block/collect-block.test.ts (new) | Decision logic is pinned; add a collect-level stop/continue wiring case. Live form needs damaged items (components), which Mine Labs inventory cannot express. |
| flat/collect/water-mining-cancel.yaml | pass | white-box | Cancelling a dig when water arrives stops the pickaxe and holds the idle stance against the current (drift < 0.3). |  | unit test: src/survival/baseline/idle-water.test.ts (exists) | 'an idle body resists current after a cancelled interaction' exists. Driver drives breakBlockInPlace, ReflexDriver and idle-water internals. |
| flat/explore/biome-entry.yaml | pass | action-only | explore_frontier biome warped_forest enters the biome at feet level, ignoring a loaded warped layer above spawn. |  | merge → `explore/biome-search` | Fold the decoy layer above spawn into the jump world. |
| flat/explore/biome-exhausted.yaml | pass | action-only | Exhausting one frontier column with only an overhead decoy returns partial EXPLORATION_BIOME_NOT_OBSERVED after expanding. |  | merge → `explore/biome-search` | single-action expect partial errorContains [EXPLORATION_BIOME_NOT_OBSERVED]; reach goal radius 12 at x 18. |
| flat/explore/biome-jump.yaml | pass | action-only | Biome entry happens mid-gap; exploration settles on the landing before releasing movement (reach 0.8, health 20). |  | merge → `explore/biome-search` | Airborne-entry observation was an arrangement check; the gap guarantees it. Driver asserts result.explored.biome.status entered. |
| flat/flowing-lava/inherited-stream-turn.yaml | pass | white-box | Replay of run 17's recorded landing velocity into the production actuator's step_up: arrives without lava contact. |  | unit test: src/navigation/execution/movement-controller.test.ts (new) | Log-replay case per docs/mcp/testing.md: recorded velocity (0.011574738831951432, -0.0784, 0.10747167248269794), step_up west from (0,-42,0); assert lateral coast is cancelled on the takeoff cell. |
| flat/flowing-lava/lava-advances-during-collection.yaml | pass | action-only | Lava released during collect_block obsidian dig: withdraw before contact; health 20, not burning, no death over 340 ticks. |  | merge → `pathfinder/flowing-lava-course` | Release via a one-shot tick trigger (timer or stance position) instead of /setblock on first dig tick. Any settled status is acceptable; health 20 is the verdict. |
| flat/flowing-lava/lava-advances-during-dig.yaml | fail | action-only | After a drop, lava released while navigation digs obsidian ahead: no damage or burn. | pathfinder/lava-containment (static lava only) | merge → `pathfinder/flowing-lava-course` | Run: behaviour: died in released lava during a navigation dig. Release triggered on landing at the drop cell via position tick trigger. Previously died. |
| flat/flowing-lava/parkour-between-streams.yaml | pass | action-only | Navigate across a three-block gap through a one-block opening between two falling lava streams; health 20. | pathfinder/gauntlet-lava-parkour (gaps over a lava bed, no streams) | merge → `pathfinder/flowing-lava-course` | requireParkour was an arrangement check; geometry already forces the jump. |
| flat/flowing-lava/spreading-lava-obstacle-course.yaml | fail | action-only | One navigate across an 80x30 arena while three released sources spread over the planned route: arrive with health 20, no lava contact. |  | merge → `pathfinder/flowing-lava-course` | Run: behaviour: died in spreading lava; route cancelled. Known failing since 2026-09-13 (reaches goal at 2 health). Release gates with a tick trigger at trial start; keep tag regression. The dry-route and passed-before-flood checks were arrangement checks. |
| flat/flowing-lava/step-up-turn-beside-lava-stream.yaml | pass | action-only | Three step-ups then a west turn beside a falling lava stream with no health loss or fire. |  | merge → `pathfinder/flowing-lava-course` | Run 17 final lava contact (request 205). minimumStepUps was an arrangement check. |
| flat/flowing-lava/stream-slalom.yaml | pass | action-only | Navigate a narrow zigzag bridge past four falling lava streams; health 20. |  | merge → `pathfinder/flowing-lava-course` |  |
| flat/hunt/blaze-bystander.yaml | pass | action-only | Hunt kills a NoAI blaze without any hurt event on a NoAI zombified piglin 0.7 blocks beside it; health 20. |  | merge → `hunt/blaze-rods` | Black-box bystander proof: give the piglin Health:1f so any hit kills it; goal entityCount zombified_piglin min 1. Keep this blaze NoAI to pin adjacency. |
| flat/hunt/blaze-rod-bow.yaml | pass | action-only | Blaze hunt with bow, 32 arrows, sword, shield and armour kills the blaze and survives (defeat-only). |  | merge → `hunt/blaze-rods` | Bow and arrows in the merged loadout; armour via players[].equipment (no wear_armor step). |
| flat/hunt/blaze-rod-single.yaml | pass | action-only | Melee blaze hunt kills one blaze and survives (defeat-only). |  | merge → `hunt/blaze-rods` | Subsumed by the two-blaze request. |
| flat/hunt/blaze-rods.yaml | pass | action-only | Hunt kills two blazes and survives (defeat-only). |  | merge → `hunt/blaze-rods` | Base of the merged fixture. Guarantee rods with HandItems blaze_rod + HandDropChances 2.0 so the goal is acquisition (hasItem blaze_rod 2), not defeat. |
| flat/hunt/chicken-bow-uneven.yaml | pass | action-only | Six feathers collected from ten wandering chickens on grass terraces while carrying bow, arrows and sword. |  | merge → `hunt/pasture-sequence` | Chicken step of the sequence. Shot-geometry logging is diagnosis only. Optionally HandItems feather to remove loot randomness. |
| flat/hunt/cow-above-cave.yaml | pass | action-only | Hunt a NoAI cow 54 blocks above a cave with pickaxe, sword, cobblestone: beef gained. |  | merge → `hunt/awkward-quarry` | 2026-09-08 search_time limit incident (entity goal must credit ascent). Cow step after the skeleton. |
| flat/hunt/cow-contact-boundary.yaml | pass | action-only | A NoAI cow at x 8.9 (inside 8-cell approach, outside 8-block contact) is reached and its beef gained. |  | merge → `hunt/pasture-sequence` | First step: the only cow in the pasture world, exact 8.9 offset from the start. |
| flat/hunt/cow-mixed-combat.yaml | pass | action-only | Eight beef from fleeing cows across terraces at midnight with zombies, skeleton and creeper present; bot survives. |  | migrate → `hunt/cows-under-mixed-hostiles` | Armour via equipment (offhand shield). Posture recording dropped (diagnosis). Absorbs cow-terrain-controls. |
| flat/hunt/cow-terrain-controls.yaml | pass | action-only | Eight beef from fleeing cows across terraces and lowered floors (no hostiles). |  | merge → `hunt/cows-under-mixed-hostiles` | Same terrain and cows as cow-mixed-combat, which adds hostiles; the beef goal is identical. |
| flat/hunt/dripleaf-pool-pinned.yaml | fail | action-only | Hunter starting pinned crouched under a flat big dripleaf in a pool breaks the leaf and kills a NoAI 100-HP zombie; survives. |  | merge → `hunt/awkward-quarry` | Run: stale: HUNT_NO_SHIELD: hostile quarry without a shield. 2026-09-12 incident (second half). PinnedHunter player in its own translated pool. Needs allow_without_shield: true (zombie is hostile quarry; legacy carried no shield). Also pinned by overhead-pin-release.test.ts (exists). |
| flat/hunt/dripleaf-pool-trap.yaml | fail | action-only | Hunter on a ledge reaches a NoAI zombie past a big-dripleaf pool (route round or pin release) and kills it; survives. |  | merge → `hunt/awkward-quarry` | Run: stale: HUNT_NO_SHIELD: hostile quarry without a shield. 2026-09-12 lush-cave incident (seed 15276542 request 168). PoolHunter player. allow_without_shield: true. Yielding trait pinned by block-geometry.test.ts (exists). |
| flat/hunt/ender-pearl.yaml | pass | action-only | Enderman hunt with roof cover, sword, shield, bow and armour kills the enderman and survives (defeat-only). |  | merge → `combat/enderman-hunt` | HandItems ender_pearl with drop chance 2.0 turns it into an acquisition goal (hasItem ender_pearl 1). Armour/shield via equipment. |
| flat/hunt/enderman-bystander.yaml | pass | white-box | ScenarioCombat engages a target enderman beside a moving neutral enderman on a 2-block step: target hit, bystander unhit and at 40 health. |  | unit test: src/survival/control/combat/controller.test.ts (exists) | Recorded geometry pinned by 'sword selection respects the observed moving enderman on the slope'. |
| flat/hunt/hostile-hunt-health.yaml | pass | white-box | engageTarget via ScenarioCombat stops attacking after /damage drops health below 12 and returns capability_blocked recovery with regeneration off. |  | unit test: src/survival/control/combat/engagement.test.ts (exists) | 'blocked recovery reports its capability rather than retrying a wounded fight'; also hunt-mob.test.ts 'a wound mid-engagement is left to combat'. |
| flat/hunt/hunt-drop-cancel.yaml | pass | white-box | Calls collectDropAfterDeath then sweepDropsAfterDeath with an aborted signal: settlement within 1 physics tick. |  | unit test: src/utils/signals.test.ts (exists) | 'armSignal: an already true condition or an already delivered cancellation resolves without listening'. |
| flat/hunt/hunt-drop-lava.yaml | pass | white-box | observeHuntDrops records a summoned magma cream that burns in lava as no_longer_observed at a lava cell, not collected. |  | unit test: src/actions/hunt-mob/drop-accounting.test.ts (exists) | 'records a drop moving from air into lava without claiming destruction or pickup'. |
| flat/hunt/pearl-occupied-scaffold.yaml | pass | white-box | pickupObservedItem collects a pearl on a raised ledge while a NoAI enderman stands in the direct scaffold cell. |  | merge → `pathfinder/item-pickup-course` | Black-box: declare the item entity (type item, Item ender_pearl, PickupDelay 0) and request pick_up_items {item: ender_pearl, x:3,y:-57,z:0}; goals hasItem ender_pearl 1, survive. Folder follows wherever other pick_up_items fixtures land. |
| flat/hunt/rabbit-at-sixty-five.yaml | pass | action-only | Hunt reaches and kills a rabbit 65 blocks away on open ground (beyond the 32-block detour bound). |  | merge → `hunt/pasture-sequence` | Last step. Place the rabbit about 80 blocks east so it is still beyond 32-65 blocks from where earlier steps leave the bot; HandItems rabbit_hide makes it an acquisition goal. |
| flat/hunt/rabbit-behind-fence.yaml | pass | action-only | Hunt for a loaded rabbit sealed in bedrock terminates non-succeeded, gains no hide, bot alive. |  | merge → `hunt/pasture-sequence` | single-action expect failed; goals survive + completion (no hasItem). Timeout bounds the truthful termination. |
| flat/hunt/skeleton-above-ceiling.yaml | pass | action-only | Hunt reaches and kills a NoAI skeleton 4 blocks above through a stone ceiling. |  | merge → `hunt/awkward-quarry` | Run 16 request 77 (obstructed bow cancelled its own approach). First step; skeleton in a sealed pocket above the cave; HandItems bone for acquisition. |
| flat/hunt/spare-shield.yaml | pass | action-only | Skeleton arrow hunt whose worn offhand shield (damage 335) breaks on the first blocked arrow: spare shield equipped, blocking resumes, arrow collected. | tests/minecraft/scenarios/hunt/arrow-hunt-spends-no-arrows.yaml (partly) | merge → `hunt/skeleton-hunts` | Legacy prepare hook; black-box: one-shot tick 'item replace entity X weapon.offhand with minecraft:shield[minecraft:damage=335]' plus a spare shield in inventory; driver asserts exactly one shield remains. Equipment strings cannot carry components today. |
| flat/hunt/spawner-camp-quarry.yaml | pass | action-only | camp_spawner hunt from 20 blocks away returns to the remembered spawner, quarry appears there (tick summon), white wool collected. |  | migrate → `hunt/spawner-camp` | single-action collect_mob_drop sheep white_wool camp_spawner true observe_for_ms 1500; keep tick summon; add reach goal near the spawner (absorbs timeout's return check). |
| flat/hunt/spawner-camp-timeout.yaml | pass | action-only | Quiet spawner camp returns observation_exhausted with no wool after returning within 4 blocks of the spawner. |  | unit test: src/actions/hunt-mob/spawner-camp.test.ts (exists) | 'an empty camp returns observation_exhausted after one return and a finite wait'; the physical return is kept by hunt/spawner-camp's reach goal. |
| flat/hunt/two-white-sheep.yaml | pass | action-only | Hunt two wandering white sheep and gain two white wool. |  | merge → `hunt/pasture-sequence` | Sheep step. |
| flat/survival/bucket-fall-10.yaml | pass | action-only | Idle runtime survives a 10-block drop (platform removed by /setblock) at 20 health, pours and reclaims its water bucket. |  | delete: intermediate height between the 5-block (threshold) and 40/80-block falls that are kept | Folded into the Fall5 player (5 blocks is the tighter low-height timing). Platform removal becomes a tick command at start. |
| flat/survival/bucket-fall-20.yaml | pass | action-only | Idle runtime survives a 20-block drop at 20 health and ends holding the water bucket. |  | delete: intermediate height between the 5-block (threshold) and 40/80-block falls that are kept | Folded into Fall80Storage (intermediate height; forecast math is pinned by src/navigation/mineflayer/water-landing.test.ts). |
| flat/survival/bucket-fall-40-edge.yaml | pass | action-only | Body edge (x 0.95) lands on a one-higher End-stone step while its centre is over the lower floor; still 20 health and bucket reclaimed. |  | merge → `survival/bucket-fall-saves` | Edge40 player keeps the exact 0.95 start offset and step geometry. Forecast also pinned by water-landing.test.ts 'body's edge catches a raised full floor'. |
| flat/survival/bucket-fall-40-end-launch.yaml | pass | white-box | 40-block fall after a fake client-side entity_velocity launch (31200,25304,-1577) survives at 20 health with bucket reclaimed. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Recorded End launch; 'recorded last End fall gives two ticks warning' pins the forecast. Impulse is a client packet the server never sent, so no black-box form; a real launch belongs to the End fixtures. |
| flat/survival/bucket-fall-40-hole.yaml | pass | action-only | 40-block fall into a 1x1, 5-deep End-stone hole ends at 20 health with the bucket reclaimed. |  | merge → `survival/bucket-fall-saves` | Hole40 player; same hole geometry translated. |
| flat/survival/bucket-fall-40-impulse.yaml | pass | white-box | 40-block fall with an injected fake sideways/upward velocity packet still lands safely with bucket reclaimed. |  | delete: fake client velocity variation; redirect logic pinned by water-landing.test.ts | 'an impulse before a planned pour redirects its landing' and relaunch tests cover the decision; no recorded incident. |
| flat/survival/bucket-fall-40-storage.yaml | pass | action-only | 40-block fall with the only water bucket in a storage slot (not hotbar) still saves at 20 health and reclaims it. |  | merge → `survival/bucket-fall-saves` | Fall80Storage player: grant nine hotbar-filling stacks before water_bucket so give lands it in storage (no driver slot move). |
| flat/survival/bucket-fall-40.yaml | pass | action-only | Idle runtime survives a 40-block drop at 20 health with the water bucket reclaimed. |  | merge → `survival/bucket-fall-saves` | Folded into Fall80Storage (stricter height). |
| flat/survival/bucket-fall-5.yaml | pass | action-only | Idle runtime survives a 5-block drop (would cost 2 health) at 20 health with the bucket reclaimed. |  | merge → `survival/bucket-fall-saves` | Fall5 player. |
| flat/survival/bucket-fall-80-fast.yaml | pass | white-box | 80-block fall with a fake -28000 vertical velocity packet once airborne still lands safely. |  | delete: fake client velocity variation, no incident | Server never produces this speed for a player; forecast speed range is unit territory (water-landing.test.ts) if wanted. |
| flat/survival/bucket-fall-80-reversal.yaml | pass | white-box | 80-block fall with two fake velocity packets (sideways then reversal at tick 24) still lands safely. |  | delete: fake client velocity variation, no incident | Relaunch/redirect decisions pinned by water-landing.test.ts redirect and relaunch tests. |
| flat/survival/bucket-fall-80.yaml | pass | action-only | Idle runtime survives an 80-block drop at 20 health with the bucket reclaimed. |  | merge → `survival/bucket-fall-saves` | Fall80Storage player (80 blocks + storage slot). |
| flat/survival/bucket-fall-corner-drift.yaml | pass | white-box | Diagonal fake impulse drifts the falling body onto a raised End-stone corner (eighth-tower fatal fall) yet it survives with bucket. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Eighth-tower incident pinned by 'the recorded eighth-tower diagonal corner gives two ticks to pour'. |
| flat/survival/bucket-followup-launch.yaml | pass | white-box | After a fake first launch a second fake dragon launch before water contact; all poured sources reclaimed, 20 health, ends at y63. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Incident: native integration e739f19 poured five ticks early. Pinned by 'a slow approach keeps its bucket until the final two forecast ticks' and relaunch tests. |
| flat/survival/bucket-reclaim-airborne-launch.yaml | pass | white-box | As followup-launch with the second launch at airborne tick 7 while dry: the stranded original source must be reclaimed. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | e739f19 incident; pinned by 'a redirected planned drop counts both pours and both independently observed recoveries' and 'relaunch retains its issued pour'. |
| flat/survival/bucket-reclaim-launch.yaml | pass | white-box | As followup-launch with the second launch at tick 8: original source reclaimed and bucket refilled before the final pour. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Same e739f19 incident as the two rows above. |
| flat/survival/bucket-refusals.yaml | pass | white-box | Direct calls to waterableLanding/saveWaterLanding/predictWaterLanding refuse slab, fence, magma, lava, water, waterlogged floors, a body-edge slab and Nether use without moving or emptying the bucket. |  | unit test: src/navigation/mineflayer/water-landing.test.ts (exists) | Covered by 'water admission rejects partial floors, lava, existing sources...', 'forecast refuses partial ledges', 'native collision-empty fluids and hazards are refused', 'Nether and unknown dimensions never admit a water bucket'. |
| flat/survival/death-recovery.yaml | pass | action-only | After /kill with keepInventory off, pick_up_items recover_death_items regains >=90% of a 57-item kit and its reported gain equals the inventory. |  | migrate → `survival/death-recovery` | Kill at start via one-shot tick ('kill @a[name=X,tag=!killed]' then tag). Needs settle-before-action (see harness gaps). Set world spawn inside the arena. Goals: hasItem at about 90% per item (cobblestone 29, oak_log 14, iron_ingot 7, diamond_pickaxe 1) + completion. |
| flat/survival/drowning-beside-dolphin.yaml | pass | action-only | Idle bot in a roofed flooded chamber, beside a dolphin with Air 6000, surfaces (digging the roof) and ends breathing with >=14 health. |  | merge → `survival/breath-reflex` | SealedDiver player; superset of drowning-bot-surfaces (same chamber plus dolphin pool). Proves own-air metadata, not a neighbour's, drives the reflex. |
| flat/survival/drowning-bot-surfaces.yaml | pass | action-only | Idle bot in a sealed flooded chamber under a stone roof digs out and ends with full air and >=14 health. |  | merge → `survival/breath-reflex` | Eighth playthrough drowning (breath reflex claims at half air whoever owns the body). Same arrangement as SealedDiver minus the dolphin; fold there. |
| flat/survival/hungry-bot-eats.yaml | pass | action-only | Idle bot drained to hunger 10 raises its hunger by eating carried food without a request. |  | merge → `survival/eating-reflex` | HungryBot player. First playthrough went 70 minutes without eating. Drain server-side: setup 'scoreboard objectives add food food'; tick gives hunger 255 until score food<=10, then tags and clears. Driver proves a carried food item was consumed and food >=14 at end. |
| flat/survival/lava-escape-step-nether.yaml | pass | action-only | In the Nether with an unusable water bucket, a bot teleported into a lava pool with no bank in reach places a step, exits, and ends alive, out of lava and not burning. |  | merge → `survival/nether-idle-survival` | Dimension and regeneration differ from the overworld fire scenario. Replace the driver /tp with a one-shot tick tp at start; vitals driver checks inLava false and burning not true after ~340 ticks. |
| flat/survival/lava-escape-step.yaml | fail | action-only | Bot teleported into the centre of a lava pool with only cobblestone places a step and climbs out alive, not in lava, not burning. |  | merge → `survival/fire-reflex` | Run: behaviour: died in the lava pool before placing a step. LavaPoolBot player; one-shot tick tp into the pool at start. |
| flat/survival/shallow-lake.yaml | pass | action-only | Idle bot standing in a two-deep lake is alive with a full air bar after 500 ticks. |  | merge → `survival/breath-reflex` | ShallowIdler player. |
| flat/survival/soul-fire-contact.yaml | pass | action-only | Soul fire set in the idle bot's feet cell; after 240 ticks it is alive, out of fire and no longer burning. |  | merge → `survival/fire-reflex` | SoulFireBot player; one-shot tick 'execute at @a[name=X,tag=!lit] run setblock ~ ~ ~ soul_fire' then tag. Fortress-route incident (fire under a settled body). |
| flat/survival/soul-fire-during-fight.yaml | pass | action-only | Soul fire set under the bot once the hostile reflex owns it against a zombie; it survives, leaves the fire and stops burning. |  | merge → `survival/fire-reflex` | Legacy timing keyed on internal owner; black-box trigger is world-observable (zombie within 2.5 blocks of the bot). Folded into the request-handoff form, which adds a navigate request on the same arrangement. |
| flat/survival/soul-fire-request-handoff.yaml | pass | action-only | During navigate to (-6,-60,0), a zombie fight is interrupted by soul fire underfoot; bot arrives, survives, not burning. |  | merge → `survival/fire-reflex` | Base fixture of the merged scenario: navigate range 1 + zombie at 3 blocks + proximity-triggered soul fire; goals reach, survive, completion, vitals burning not true. |
| flat/survival/soul-fire-sealed-contact.yaml | pass | action-only | Soul fire set inside an occupied sealed 1x2 cobblestone refuge; bot survives, ends contact and burning. |  | merge → `survival/fire-reflex` | SealedFireBot player, same one-shot fire trigger. |
| flat/survival/soul-sand-lava-contact.yaml | pass | action-only | Bot teleported to x 0.7618 overlapping a lava strip from soul sand (Mineflayer isInLava false) escapes west, survives and stops burning. |  | merge → `survival/fire-reflex` | EdgeBot player; one-shot tick tp to the recorded fractional position. Mechanism pinned by src/survival/responses/fire.test.ts 'lava contact includes the shallow body overlap' (exists). Goal: final x < 0.7 needs a reach goal or vitals inLava false. |
| flat/survival/waterfall-centered-control.yaml | pass | action-only | Centered idle bot in a 35-block falling-water column survives 40 s with full air and >=14 health. |  | delete: control run for waterfall-offset-overhang; the offset case is the incident and is kept | CenterDiver player (control). Bot must be tp'd into the column at start; the host waits for ground, so it starts on a dry ledge. |
| flat/survival/waterfall-low-air-bedrock.yaml | pass | action-only | Empty-handed bot released at 120 air under an undiggable bedrock overhang swims clear and refills air, >=14 health, alive 40 s. |  | merge → `survival/breath-reflex` | LowAirDiver player. Air drained server-side: start in sealed bedrock pocket; tick 'execute as @a[name=X,tag=!released] store result score @s air run data get entity @s Air', tp when air<=120, then tag. 2026-09-09 drowning follow-up. |
| flat/survival/waterfall-offset-overhang.yaml | pass | action-only | Off-centre idle bot (x 0.026, z 0.090) whose shoulder overlaps a deepslate overhang regains air and survives 40 s with >=14 health. |  | merge → `survival/breath-reflex` | OffsetDiver player; EnderSeeker 2026-09-09 drowning. Also pinned by src/survival/positioning/swim-escape.test.ts (exists). One-shot tick tp to the exact fractional position. |
| flat/survival/wounded-bot-eats.yaml | pass | action-only | Bot at 14 health with hunger 15-17 (no regeneration) eats bread and regenerates to >=18 health. |  | merge → `survival/eating-reflex` | HurtHungryBot player. Drain hunger to <=17 by tick, then one-shot '/damage X 6 minecraft:magic' after the drain (YAML health:14 would regenerate before the drain). Goal health 18. |
| flat/water/air-pocket-to-ocean.yaml | pass | white-box | navigate from a dry bedrock chamber to the sea is refused no_path within 10 s; dirt hatch under source water intact; health 20; policy check opens_into_liquid via createMovements. |  | delete: redundant with kept sibling ocean-to-air-pocket; policy cause pinned by movement-policy.test.ts | Same refusal reason and safety goals as the migrated sibling; deferred crossing capability noted in ocean-air-transitions.md. |
| flat/water/idle-underwater-survival.yaml | pass | action-only | Idle bot at the bottom of a deep open pool stays alive 40 s and loses at most 2 health. |  | merge → `survival/breath-reflex` | DeepIdler player; health goal >=18. |
| flat/water/ocean-to-air-pocket.yaml | pass | white-box | navigate from the sea down a shaft into an air pocket behind a dirt plug is refused no_path within 10 s; plug intact; health 20; breathing recovered. |  | merge → `pathfinder/underwater-course` | single-action navigate expect failed (errorContains the no_path marker); blocksAt dirt for both plug cells; health 20. Drop the createMovements policy probe (white-box). |
| flat/water/swim-physics.yaml | pass | white-box | Nothing behavioural: the driver holds controls itself and records sink/hold/wall/rise physics; passes unconditionally. |  | delete: diagnostic control probe, no verdict | - |
| flat/water/underwater-air-limit.yaml | pass | action-only | navigate to the seabed of a 12-deep pool is refused (not succeeded) and the bot ends unhurt with full air. |  | merge → `pathfinder/underwater-course` | Refusal leg (needs per-leg expect in navigate-route, see harness gaps). Deep shaft section of the course world. |
| flat/water/underwater-backstop.yaml | pass | action-only | Glass dropped 3 above a diving bot blocks its way up; breath reflex takes over; request does not claim success; health 20, air full. |  | merge → `pathfinder/underwater-course` | One-shot tick places glass over the bot once below y -58.5 during the seabed leg; the next leg (back to the surface) must still arrive at full health. 'Request reports failure' and reflex-seen assertions are tactic-coupled. |
| flat/water/underwater-blocked.yaml | pass | action-only | navigate to a cell under a solid stone shelf (dig off) is refused and bot stays unhurt. |  | merge → `pathfinder/underwater-course` | Refusal leg; shelf area in the course world. |
| flat/water/underwater-breathing-stop.yaml | pass | action-only | collect_block 4 sand on a 3-deep seabed succeeds with the gain, 20 health, full air; planned breathing (not the reflex) observed. |  | merge → `collect/underwater-sand` | Base of the merged fixture. Drop the breathing/reflex event assertions (tactic); keep hasItem sand 4 + health 20. |
| flat/water/underwater-cancel.yaml | pass | action-only | Cancelling navigate at depth reports non-success and the idle handoff returns the bot to air unhurt. |  | unit test: src/navigation/diving.test.ts (exists) | Driver-side cancellation is not in the black-box contract. 'a dive declaration and its watcher end on success, cancellation, and exceptions' plus breath.test.ts cover it. |
| flat/water/underwater-collection.yaml | pass | action-only | collect_block 1 sand from a 3-deep seabed succeeds with the inventory gain, 20 health, full air. |  | merge → `collect/underwater-sand` | Weaker sibling of breathing-stop (1 vs 4 sand). |
| flat/water/underwater-current.yaml | pass | action-only | navigate crosses a one-cell water current both ways and exits to dry footing, arriving exactly, 20 health. |  | merge → `pathfinder/underwater-course` | Current channel translated beside the pool; three legs. |
| flat/water/underwater-descent.yaml | pass | action-only | navigate to a midwater cell then back to the surface, exact arrivals, 20 health, full air. |  | merge → `pathfinder/underwater-course` | Midwater leg. |
| flat/water/underwater-replan.yaml | fail | action-only | Glass injected on the committed route at depth; run replans without a start_changed search and arrives, 20 health. |  | merge → `pathfinder/underwater-course` | Run: behaviour: the injected glass caused a start_changed replan, which the fixture forbids. Black-box: one-shot tick glass at a fixed cell on the obvious route when the bot is below -58.5; goal is arrival. Search-reason assertion is implementation-coupled. |
| flat/water/underwater-seabed.yaml | pass | action-only | navigate down to the seabed then back up, exact arrivals, 20 health, full air. |  | merge → `pathfinder/underwater-course` | Seabed leg. |
| flat/water/underwater-turn.yaml | pass | action-only | Midwater route turns around a pillar holding depth within 0.35 blocks, then surfaces; 20 health. |  | merge → `pathfinder/underwater-course` | Arrival legs kept; depth-band assertion dropped (pinned by src/navigation/execution/movement-controller.test.ts 'submerged arrival waits for a held depth band'). |

### Everything else (57)

| Fixture | Verdict | Kind | Verifies | Covered by | Fate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| default/hunt/wild-animal-hunt-20260904.yaml | fail | action-only | view_status then hunt the nearest loaded cow/sheep/pig/chicken for its guaranteed drop on seed 20260904; drop gained and target position reported. |  | delete: seed variant of hunt/wild-animal-and-receipts | Run: stale: drop gained; the driver requires a target position the result no longer names. One seed kept. |
| default/hunt/wild-animal-hunt-8674349.yaml | pass | action-only | Same wild hunt on seed 8674349 from (-25.5,99,6.5). |  | delete: seed variant of hunt/wild-animal-and-receipts | One seed kept. |
| default/hunt/wild-animal-hunt-8675309.yaml | pass | action-only | Same wild hunt on seed 8675309 from (8.5,64,-19.5). |  | merge → `hunt/wild-animal-and-receipts` | Kept seed; incident was a loaded rabbit 65 blocks off that the hunt would not walk to. Custom driver (dynamic input from view_status) through call(). |
| default/observation/loaded-mobs-20260904.yaml | pass | action-only | view_status loaded-mob summary on seed 20260904 parses, is nonempty, nearest-first, in Markdown, and the live registry loads no mob type outside MOB_KINDS. |  | delete: seed variant; see loaded-mobs-8675309 | - |
| default/observation/loaded-mobs-8674349.yaml | pass | action-only | Same loaded-mob contract check on seed 8674349. |  | delete: seed variant; see loaded-mobs-8675309 | - |
| default/observation/loaded-mobs-8675309.yaml | pass | action-only | Same loaded-mob contract check on seed 8675309. |  | merge → `hunt/wild-animal-and-receipts` | The merged driver already reads view_status first: assert schema, nonempty, nearest-first, Markdown lines there. The registry-type coverage check becomes a deterministic NEW unit test in src/actions/view-status/view-status.test.ts: every minecraft-data 1.21.4 entity in a mob category maps to a published MOB_KIND. |
| default/progression/craft-after-collect.yaml | pass | action-only | Three rounds of collect 8 logs then one craft batch starting with crafting_table (+wooden pickaxe/axe/sword) succeed on seed 8674349 (seventh-playthrough failure). | craft/workshop (partly) | merge → `progression/progression-to-diamond` | Make the progression's opening stage this exact shape (collect logs then the four-item batch); three verification locations replace three rounds. Packet tail evidence dropped. |
| default/receipts/settled-counts-20260904.yaml | pass | action-only | eat_food, place_block (no coords) and craft_item stick x4 each report confirmed:true with the exact inventory delta on seed 20260904. |  | delete: seed variant of hunt/wild-animal-and-receipts | - |
| default/receipts/settled-counts-8674349.yaml | pass | action-only | Same three receipts on seed 8674349. |  | delete: seed variant of hunt/wild-animal-and-receipts | - |
| default/receipts/settled-counts-8675309.yaml | pass | action-only | Same three receipts on seed 8675309. |  | merge → `hunt/wild-animal-and-receipts` | Driver drains hunger with /effect; replace with a YAML tick "execute as @a[name=X] if data entity @s {foodLevel:20} run effect give @s minecraft:hunger 1 255 true" (or a Mine Labs players[].food field). Receipt checks run after the hunt in the same driver. |
| default/stronghold/locate-resume.yaml | pass | action-only | Two cancelled locate calls with SQLite reopened between them, estimate from saved bearings, supply refusal, override travel with one refinement throw; portal frame (269,-22,-1595) confirmed, surface eyes recovered, eye count exact. |  | migrate → `explore/locate-stronghold` | Run: harness: first attempt errored (Mine Labs rcon forceload timed out under load); passed on a serial retry. Black-box sequence: locate_stronghold (estimate) -> {phase: locate} expect [STRONGHOLD_MISSING_SUPPLIES] -> {phase: locate, continue_without_recommended_items: true}; goals blockAt frame, reach r190, hasItem ender_eye >=13. Mid-flight cancellation and SQLite reopen are not black-box; pinned by locate-stronghold.test.ts (exists: SQLite reopen, cancelled wait, saved bearings resume) and recover-eye.test.ts. |
| default/terrain/long-haul-terrain.yaml | pass | white-box | context.navigation walks 160 blocks of seed 8675309 terrain in 40-block nearXz legs into unloaded chunks; arrive within 4 blocks at full health. |  | migrate → `pathfinder/generated-long-haul` | Black-box: one navigate {x: 63, z: -170, range: 3} with no y (night-haul already relies on that); goals reach (column), health 20, completion. Tests segment continuation over unloaded chunks. |
| default/terrain/navigation-creeper-rocky-crossfire.yaml | pass | action-only | At 13 health at midnight, navigate from the 2026-09-12 rocky slope past creeper, spider, zombie and skeleton to (-220,68,-109) alive. |  | migrate → `combat/creeper-rocky-crossfire` | prepare hook only wears armour and equips the shield: players[].equipment. Single-action navigate; goals reach/survive/completion. |
| default/terrain/night-hostile-haul-20260904.yaml | pass | action-only | One navigate of 120 blocks at midnight with mob spawning on (hostile field live), seed 20260904 steep terrain: arrive alive. |  | migrate → `combat/night-hostile-haul` | Kept seed (steepest, all-land bearings). Equipment via YAML; single-action navigate {x,y:86,z,range:3}. |
| default/terrain/night-hostile-haul-8674349.yaml | pass | action-only | Same night haul on seed 8674349. |  | delete: seed variant of combat/night-hostile-haul | - |
| default/terrain/night-hostile-haul-8675309.yaml | pass | action-only | Same night haul on seed 8675309 (long-haul column). |  | delete: seed variant of combat/night-hostile-haul | Seed 8675309 terrain kept by pathfinder/generated-long-haul. |
| default/terrain/ocean-sand-shaft.yaml | pass | action-only | collect_block sand at (1414,59,-91) from water above an ocean stronghold (11 Sept 2026): sand gained, health 20, within 90 s. |  | migrate → `collect/ocean-sand-shaft` | Known failing: after the start_changed fix it still returns NO_REACHABLE_MATCHING_TARGETS underwater; keep the success contract (tag regression). Start-cell churn unit-pinned in src/navigation/orchestration/navigation-run.test.ts. |
| default/terrain/scaffold-end-stone.yaml | pass | action-only | In the End, navigate build:true up 5 blocks with only end_stone carried; default policy scaffolds end_stone, column observed. | pathfinder/obstacle-course-scaffolding (other material) | merge → `combat/end-crystals-every-method` | Baseline 96e0a60 excluded end_stone from the scaffold allowlist. The pillar-approach crystals carry only end_stone, so a missing allowlist entry fails them. Unit cover: portal-entry.test.ts asserts end_stone among scaffolding. |
| flat/barter/resumed-reward.yaml | pass | white-box | A fixture reflex claim during a one-gold exchange resumes and still yields blackstone with exactly one gold spent. | barter/ground-first (zero-gold branch) | unit test: src/actions/barter/barter.test.ts (exists) | 'runner takeover preserves a pending offer' and 'a consumed offer survives cancellation and resumption without spending twice' exist. Live exchange kept by seeded-reward's merge. |
| flat/barter/seeded-reward.yaml | pass | action-only | Native one-gold piglin exchange with a reset loot sequence yields blackstone; exactly one gold spent and offered. | barter/ground-first (zero gold only) | merge → `barter/ground-first` | Add a second barter (blackstone, gold_budget 1); 'random reset minecraft:gameplay/piglin_bartering 0 false false' as setup; driver asserts goldSpent 1 = observed; helmet via equipment. |
| flat/barter/takeover-output.yaml | pass | white-box | An incidental reward picked up during a fixture takeover does not end the resumed two-gold barter early. |  | unit test: src/actions/barter/barter.test.ts (exists) | 'an incidental reward observed entirely during takeover allows the next reserved offer' exists. |
| flat/build/roof-gap.yaml | pass | action-only | build_structure camp walls and roof around a furnace and bed while inside it, across cobblestone stack boundaries; roof cell placed. |  | merge → `build/enclosures` | Run 12 stack-boundary incident. YAML inventory cobblestone 127 gives a 64/63 boundary; the exact 47/63/17 split needs per-slot inventory. Goal blocksAt the full roof. |
| flat/build/sealed-box.yaml | pass | action-only | Build a hollow 3x3x3 box around the bot's start, finishing from outside; roof cell present and bot outside. |  | merge → `build/enclosures` | Driver's 'ended outside' check becomes view_status position, or a reach goal outside the box. |
| flat/craft/application-capacity.yaml | pass | white-box | Full inventory refuses a chest needing intermediate planks without dropping; a free slot or the slot freed by the last log allows it. |  | unit test: src/world/crafting.test.ts (exists) | Same three cases as capacityControls and the full-inventory refusal test. Driver called craftItem directly with /give. |
| flat/craft/eye-chain.yaml | pass | white-box | craft ender_eye 6 from 3 blaze rods and 7 pearls via powder; authoritative inventory has 6 eyes, 1 pearl, no rods or powder, empty grid. |  | merge → `craft/recipe-chains` | Black-box: craft_item ender_eye 6; driver view_status exact counts (no leftover rods or powder). Raw window_click snapshot was a fixture-only probe. |
| flat/craft/recipe-remainders.yaml | pass | white-box | Honey block keeps 4 glass bottles, cake keeps 3 buckets; a full inventory refuses honey block before any click. |  | merge → `craft/recipe-chains` | Black-box the remainder cases (honey_block by hand, cake at a table); the full-inventory refusal is the crafting.test.ts capacity rule. |
| flat/craft/smelt-batch-normal.yaml | pass | action-only | Smelt 16 raw iron with 2 coal at a placed furnace at normal tick rate: 16 ingots, 0 raw, receipt agrees. | craft/workshop (16 TPS batch of 9) | merge → `craft/recipe-chains` | Kept by 2db0f41 for the normal-tick batch. The chains fixture runs at 20 TPS, so this is where it lands; 16 items use exactly 2 coal. |
| flat/drop/disposal-hole-offset.yaml | pass | action-only | From an off-centre stance, disposal digs the nearer western hole, keeps the footing, health 20. | drop/disposal-hole-bedrock (refusal only) | merge → `drop/disposal-holes` | Start the merged fixture at the offset stance. |
| flat/drop/disposal-hole-underground.yaml | fail | action-only | In a stone tunnel, disposal opens the wall and keeps discards below pickup height. |  | merge → `drop/disposal-holes` | Run: behaviour: one cobblestone came back out of the hole (73, expected 72). Second stage after navigating into a stone tunnel; supply double the items. |
| flat/drop/disposal-hole.yaml | fail | action-only | Dig a two-deep hole, toss 12 flesh and all cobblestone, none picked back up after 100 ticks; rim footing kept. |  | merge → `drop/disposal-holes` | Run: behaviour: DROP_INCOMPLETE: 1 of 2 items could not be dropped. Centred-stance variant is subsumed by the offset stage. Driver: waitForTicks(100), then view_status exact counts and droppedItems. |
| flat/drop/full-inventory-disposal.yaml | fail | action-only | Full inventory: hunt pickup fails INVENTORY_FULL, disposal of 192 netherrack frees space, pickup succeeds, returning over the pit recovers no netherrack. |  | merge → `drop/disposal-holes` | Run: behaviour: 2 of 2048 netherrack unaccounted for after disposal. 35 netherrack stacks + pickaxe in YAML inventory; wool as an entities item with PickupDelay 0. Needs per-step expect; final view_status netherrack = 2048. |
| flat/equip/equip-selected-shield.yaml | pass | action-only | equip with an explicit source_slot chooses the fresh shield over a worn off-hand copy; sword stays in hand. |  | unit test: src/actions/equip/equip.test.ts (exists) | 'an explicit source slot replaces a worn shield with the selected copy' exists. Live form needs a damaged shield (item components). |
| flat/evidence/action-catalog.yaml | fail | action-only | Every published MCP tool is called once through the in-memory MCP transport; no unexpected error; vitals present; writes JSON + HTML evidence. |  | migrate → `tools/action-evidence/action-catalog` | Run: stale: shoot_dragon and prepare_dragon_perch are not published to the evidence catalogue. Documentation generator plus a catalogue-completeness check; not a tests/minecraft scenario because that suite excludes MCP transport. Move with action-evidence*.ts and repoint evidence:render. |
| flat/evidence/collection-incident.yaml | pass | action-only | Damage after a finished collection yields an incident linked as precedingRequestId with plan and physics records. |  | unit test: src/bot-data/incident-log.test.ts (exists) | Preceding-request join plus src/diagnostics/incident-recorder.test.ts plan retention. Overhead figures were logged, never asserted. |
| flat/evidence/navigation-incident.yaml | pass | action-only | Removing support mid-navigation yields a fall incident linked to the request with a nearby_block_change record. |  | unit test: src/diagnostics/incident-observer.test.ts (exists) | 'failure evidence separates lost support, server corrections, and local motion' exists. |
| flat/evidence/operator-capture.yaml | pass | action-only | POST /diagnostics/incidents during navigation writes an artifact linked to the running request, later to the preceding one, without changing notifications. |  | unit test: src/server/incident-route.test.ts (new) | No route test exists; use a fake runtime for capture during and after a request. |
| flat/evidence/player-death-runtime-event.yaml | fail | action-only | /kill during MCP navigate cancels it with the death cause, emits one player_death event, allows new work after respawn, and keeps history. |  | unit test: src/runtime/minecraft-runtime.test.ts (exists) | Run: behaviour: timed out waiting for foreground navigation admission after the death. 'death cancels the foreground action, records one event, and permits work after respawn' exists. |
| flat/evidence/server-move-incident.yaml | pass | action-only | A server teleport mid-navigation records server_position_applied and no block change in the incident. |  | unit test: src/diagnostics/incident-observer.test.ts (exists) | Same test as navigation-incident. |
| flat/portal/activate-end-and-cross.yaml | pass | action-only | Activate an End portal over lava with the last eye, enter via override, arrive on obsidian undamaged, then navigate in the End. |  | merge → `portal/end-portal-course` | Final stages of the course. Driver asserts dimension via view_status; health 20 goal. |
| flat/portal/activate-end-resume.yaml | pass | action-only | Cancel activation after three eye insertions, resume without double-spending (12 filled, 0 eyes), stay outside the opening; a repeat reports already active. |  | merge → `portal/end-portal-course` | Cancel/resume is unit-tested ('cancel after an insertion, recreate execution, and fill only the remaining sockets from outside'); the live part keeps activation from inside the opening plus the idempotent repeat. |
| flat/portal/end-entry-distant.yaml | pass | action-only | After sleeping at a bed 30 blocks away, End entry with respawn_within 8 is refused END_PORTAL_RESPAWN_DISTANT; stays in the Overworld. |  | merge → `portal/end-portal-course` | Per-step expect. |
| flat/portal/end-entry-missing.yaml | pass | action-only | End entry with no confirmed bed is refused END_PORTAL_RESPAWN_UNKNOWN; stays in the Overworld. |  | merge → `portal/end-portal-course` | First entry attempt of the course. |
| flat/portal/end-entry-near.yaml | pass | action-only | After sleeping at a nearby bed, End entry succeeds into the_end. |  | merge → `portal/end-portal-course` | In the course the near bed is used in daytime (respawnSet without sleep); confirm the guard accepts that, otherwise start the course at night. |
| flat/portal/end-entry-override.yaml | pass | action-only | With no bed, allow_distant_respawn permits End entry. | activate-end-and-cross (override entry) | unit test: src/actions/portal-entry/portal-entry.test.ts (exists) | 'End guard refuses unknown, distant, and visibly missing bed evidence while allowing the explicit override' exists. |
| flat/portal/respawn-observation.yaml | pass | action-only | Probe: after bed sleep /kill respawns at the bed; after the bed is removed, spawnReset fires and respawn is elsewhere. |  | unit test: src/actions/portal-entry/portal-entry.test.ts (exists) | 'personal respawn knowledge is confirmed separately from world spawn and invalidated by spawnReset' exists. Mineflayer/vanilla dependency probe. |
| flat/progression/primitive-progression-to-diamond.yaml | pass | action-only | Empty inventory to one diamond through 21 dependent collect, craft, place, navigate and smelt stages; health 20. |  | merge → `progression/tool-tier-progression` | Becomes the consolidated tool-tier scenario on action-sequence; params turn into the step list. |
| flat/sleep/carried-bed-night.yaml | pass | action-only | At night, place a carried bed on the only footprint and sleep until morning; respawn near it; bed cells hold the bed. |  | merge → `sleep/bed-lifecycle` | Respawn check used /kill; see harness gaps (spawn-point goal). |
| flat/sleep/nearby-bed-day.yaml | pass | action-only | Daytime sleep at a nearby bed sets respawn without claiming sleep; respawn near it. |  | merge → `sleep/bed-lifecycle` | Final stage: after the night sleep it is day; the respawn moving from the placed bed to this one is the stronger check. |
| flat/sleep/nearby-bed-night.yaml | pass | action-only | Walk to a nearby bed at night, sleep to morning, respawn near it. | sleep/bed-lifecycle | merge → `sleep/bed-lifecycle` | Night sleep is covered by the carried-bed stage and walking to a bed by the day stage. |
| flat/storage/chest-round-trip.yaml | pass | action-only | Organize, deposit and withdraw in a real chest; physical slots and SQLite container memory agree (68 cobble in slots 1-2). |  | merge → `storage/full-inventory-storage` | Black-box: use_container inspect for physical layout, query_bot_data on observed_container_slots for memory. Starting slots via setup item replace. |
| flat/storage/cramped-chest.yaml | pass | action-only | A chest with a deepslate lid is refused CHEST_BLOCKED; clearing the lid with a nearly full inventory opens it; a placed chest also opens. |  | merge → `storage/full-inventory-storage` | Per-step expect for the CHEST_BLOCKED refusal; cobbled_deepslate goal. |
| flat/storage/full-inventory-workstations.yaml | pass | action-only | From 36 occupied slots: craft and place a chest, deposit 128 cobble, craft and place a furnace, cook 2 beef; chest holds 128. |  | merge → `storage/full-inventory-storage` | Order the merged stages so the lid is cleared after the deposit frees slots. |
| flat/storage/temporary-workstations.yaml | pass | action-only | Temporary table crafts a batch incl. a table and is recovered; temporary furnace cooks and is recovered; failed plan still recovers; existing stations intact. | craft/workshop (temporary furnace only) | merge → `craft/workshop` | Add a temporary-table batch, a failed temporary diamond_pickaxe step, and pre-placed table/furnace goals to the workshop. |
| manual/runtime/microtask-hang.yaml | fail | action-only | Shipped host over MCP: a 7 s healthy debug_execute_javascript passes, then an infinite microtask loop returns RUNTIME_UNRESPONSIVE in <10 s with /health 503 and a saved incident. |  | unit test: src/server/runtime-supervisor.test.ts (exists) | Run: stale: manual probe; its assertion no longer matches the shipped host's reply. supervisorSavesFailure covers hang/microtask/sse-hang/crash with saved failure; manual destructive probe. |
| manual/runtime/synchronous-hang.yaml | fail | action-only | Same watchdog probe with an infinite synchronous loop. |  | unit test: src/server/runtime-supervisor.test.ts (exists) | Run: stale: manual probe; its assertion no longer matches the shipped host's reply. As above. |
| verification/obsidian/cast-obsidian.yaml | fail | action-only | collect_block obsidian 10 with water-bucket recovery at three separated seed-8675309 locations. | collect/cast-obsidian (one of three locations) | merge → `collect/cast-obsidian` | Run: harness: verify: 2/3 locations passed; location 1's legacy client timed out waiting for a server tick under load. Add verification: {radius: 256, locations: [[8.5,64,-19.5],[-807.5,114,800.5],[1608.5,75,1600.5]]} to the tests/minecraft fixture; `mine-labs run` expands it to three entries. |
| verification/progression/progression-to-diamond.yaml | pass | action-only | Empty inventory to diamond on generated seed 8675309 at three locations: tools, dirt, coal, iron pickaxe, diamond, health 20. |  | migrate → `progression/progression-to-diamond` | Black-box action-sequence (place_block without coordinates picks its own cell; smelt_item can use a temporary furnace), keeping the three verification locations. Driver-side findFlatPlacementCandidates and alcove clearing go away: that choice belongs to place_block. |
