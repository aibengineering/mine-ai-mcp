# Reliability and parity plan — 2026-09-13

Work queued after the last survival run. Nothing here is implemented yet. Each
item follows the same shape: **observe** the current behaviour in a real world
before touching code, **change** the smallest set of files, **prove** it with a
scenario that would have failed before. Live evidence for the observe steps
comes from the play container's incident JSONL and SQLite bot data (WSL,
`~/mine-ai-data/runs/<seed>/mcp/bot-data/.../incidents/*.jsonl`) and from
`mine-labs run` output for fixtures.

Order of attack, by how often the failure bites during a run:

| # | Item | Depends on |
| - | ---- | ---------- |
| 1 | Vine navigation reliability | — |
| 2 | Raw body action (escape hatch) | — (unblocks observing 1 and 6 when the bot is wedged) |
| 3 | Scaffold list into the survival policy, plus deepslate and end stone | — |
| 4 | Water-bucket fall save, shared with Baritone-style bucket drops | 3 (policy home for the toggle) |
| 5 | `destroy_end_crystal` weapon argument and melee measurement | — |
| 6 | Portal entry actions out of `navigate` | — |
| 7 | Item pickup and death recovery action | — |
| 8 | Combat change reporting in progress | — |
| 9 | Enderman targeting: re-rank during the approach | 8 (retarget reasons show up in progress) |
| 10 | Tool tier tracking in progress, and tool loss as an outcome | 8 (same progress plumbing) |
| 11 | Dripstone handled by the pathfinder, not the escape hatch | 2 (observe with it, then make it unnecessary) |
| 12 | Smelting leaves one item uncooked | — |

---

## 1. Vine navigation: observe, then fix

### What we know today

Climbables are `ladder`, `vine`, `weeping_vines`, `twisting_vines`
([world.ts](../../src/navigation/mineflayer/world.ts) `CLIMBABLES`). The search
offers a `climb` movement from inside a climbable or from the cell above one
([catalogue.ts](../../src/navigation/movements/catalogue.ts) `climb`). Execution
special-cases sliding down and entering from above
([movement-controller.ts](../../src/navigation/execution/movement-controller.ts),
around the `slidingDownClimbable` and descending-climb branches). Three live
incidents are already recorded in code comments:

- 2026-09-04: the bot jammed under a cobblestone it had placed itself in a vine
  shaft; the head cell was never prepared. Fixed in the catalogue, but the
  fix only covers the head cell directly above.
- At 98,-2,89: handed over mid-slide, the bot pushed sideways, hit netherrack at
  head height and rode the vine five blocks up onto a slab.
- Stepping into a vine column carried the body a whole cell sideways out of the
  column's open side into a four-block fall.
- Observed repeatedly in the last run: the plan offers a vine climb, the body
  starts up it, then slides off sideways and falls while the step is still
  "running". The horizontal controls are the cause, and this one is already
  visible in the controller without waiting for evidence: an upward `climb`
  holds `jump` and sets `forward` only when the step has a horizontal
  direction, which a vertical climb never has
  ([movement-controller.ts](../../src/navigation/execution/movement-controller.ts),
  the `initialControls` block). Nothing presses the body against the wall the
  vine hangs on, so the vine's climb is driven by jump alone, and the
  momentum of walking in, or any knockback, carries the body out of the vine
  cell. A vine only holds a body whose bounding box overlaps its cell; leave
  the cell and the climb ends in free fall. Ladders mask this because their
  own plate sits against the wall and the body tends to rest on it; vines
  have no plate. The descending branch does re-centre over the column, so the
  gap is specific to going up.

The only fixture is [vine-ladder-column.yaml](../../scenarios/flat/pathfinder/vine-ladder-column.yaml):
one wall-backed vine column, one ladder, flat world. Everything that goes wrong
in jungles and caves is outside that fixture.

### Observe first

1. Pull every `navigation` line from the live incident JSONL whose step kind is
   `climb`, or whose feet cell was a vine at the time of a `failed`/`stopped`
   route, and group by outcome. Record position, vine block state (which faces
   are set, `up=true` or not), support below, and whether a wall existed on the
   push side.
2. Reproduce each grouping as a fixture before changing anything. The
   suspected stuck modes, to be confirmed or discarded by the evidence:
   - **Free-hanging vine** (`vine[up=true]` under leaves, no wall on any side).
     Prismarine physics only sets climb speed on a horizontal collision, so the
     bot cannot ascend it, but the catalogue offers the climb anyway. Expected
     symptom: `climb` step never arrives, route loops or stalls.
   - **Vine whose wall is on a different face than the push direction**:
     the body presses east, the vine is attached north, no collision, no climb.
   - **Jungle canopy**: vines on leaves, leaves diggable, climb offered through
     a cell the bot then digs out from under itself.
   - **Column with an open side over a drop or water**: the sideways drift
     already noted; also a slide that ends in water and is then treated as a
     swim.
   - **Entering mid-column from the side** (not from the ground, not from the
     top): the walk-in step has a horizontal heading, the vine catches the body
     early, and the arrival check never fires.
   - **Nether vines**: weeping vines hang from the ceiling with nothing behind
     them; twisting vines grow up from the floor. Both are in `CLIMBABLES` and
     neither has a fixture.
   - **Scaffold interplay**: a placed scaffold block inside or beside the
     column while climbing (the 2026-09-04 case generalised to side cells).
3. For each fixture, capture what the bot does now and file it in the fixture's
   header comment, the way `vine-ladder-column.yaml` records its own reason.

### Change

The control fix can start now, since the controller shows it; the rest waits
for the fixtures to exist and fail:

- Execution, upward climb controls: hold a horizontal input toward the
  vine's attached face for the whole step, the way a player holds W into the
  wall. The face comes from the vine block state (`north`, `east`, `south`,
  `west`; `up` means it hangs from above and has no wall to press). Set the
  yaw to face that wall and use `forward`, so the body is pinned against the
  wall, stays inside the vine cell, and gets the horizontal-collision climb
  as well as the jump climb. Add lateral re-centring over the column centre
  on the two free axes, as the descending branch already does, so
  walking-in momentum is cancelled before it carries the body out of the
  cell. Ladders take the same treatment keyed on `facing`. This is Baritone's
  `MovementPillar` ladder behaviour: look at the climbable, move forward into
  it, jump.
- Execution, failure detection: "no vertical progress for N ticks while
  `climbing`", or the body leaving the vine cell with `climbing` false above
  the start height, is a step failure that replans immediately, not a slide
  the arrival check waits out.
- Catalogue: offer `climb` up only when the vine has an attached face with a
  solid block behind it in the column, or model the attachment faces as the
  push direction. Vines with only `up` set are descend-only. Weeping vines
  hang free and are descend-only; twisting vines grow from the floor and can
  be climbed with jump alone since there is no wall, which is the one case
  where the jump-only control is right.
- Recovery: when a climb fails with the body still in the column, the next
  route must be allowed to dig or place out of it. Check the search does not
  keep re-offering the same failed climb (cost memory keyed by cell).
- Telemetry: add the vine face bits and `climbing` flag to the `physics` line
  in incidents so the next stuck report is self-explanatory.

### Prove

New fixtures under `scenarios/flat/pathfinder/`: `vine-free-hanging.yaml`,
`vine-off-axis-wall.yaml`, `vine-jungle-canopy.yaml`, `vine-open-side-drop.yaml`,
`vine-mid-column-entry.yaml`, `vine-scaffold-jam.yaml`, and under
`scenarios/default/nether/` a weeping/twisting vine pair. For the control
fix specifically, `vine-sprint-entry.yaml` (enter the column at sprint speed
from three cells away, ten-block climb) and `vine-knockback-mid-climb.yaml`
(a fixture-applied sideways impulse halfway up); both assert the body never
leaves the column and the climb completes. All pass with `health: 20` and
`completion`. Add the climb branches to `movement-controller.test.ts` from
recorded physics lines, including a jump-only control set that must now be
rejected for a wall-attached vine.

---

## 2. Raw body action (escape hatch)

### Why

On dripstone the bot ended up standing where no action could act: the mining
process refused to dig because the bot was not on solid ground, `navigate`
found no route, and nothing else could swing at a block. The only fixture is
[dripstone-stairs.yaml](../../scenarios/flat/pathfinder/dripstone-stairs.yaml),
which walks over tips and never gets stuck on one.

### Observe first

Find the incident: the last `physics` line will show the feet cell as
`pointed_dripstone` or the support as a tip. Record exactly which action was
called, which refusal message came back, and what `onGround`/`velocity` were.
Reproduce as `dripstone-wedged.yaml` (bot placed on a stalagmite tip inside a
one-wide pit). Confirm whether the refusal comes from the mining process's
footing guard, from `collect_block`, or from `navigate`'s target validation.

### Change

Add one production tool, `raw_action`, distinct from the debug-only
`debug_execute_javascript`. It takes a discriminated `operation`:

| operation | fields | what it does |
| --------- | ------ | ------------ |
| `look` | `yaw`,`pitch` or `x`,`y`,`z` | turn the head, report the new heading |
| `dig` | `x`,`y`,`z` | dig the named block if within reach, with the held tool; no navigation, no footing guard beyond "not in lava" |
| `place` | `block_name`,`x`,`y`,`z`,`face` | place against the named face if within reach |
| `swing` | optional `entity_id` | one arm swing / attack |
| `use_item` | optional `hand` | activate the held item once (bucket, food, bow release) |
| `control` | `state`, `ticks` | hold one control state for a bounded number of ticks (max ~40) |

Each call is short, foreground, and reports the observed change (block before
and after, inventory delta, position delta). It carries a `destructiveHint` and
its description says plainly it is for when every other action refuses. It
does not resume; every call is one attempt.

The escape hatch is for the next unknown wedge, not for dripstone. Making
dripstone a case the pathfinder and mining process handle on their own is
item 11.

### Prove

`dripstone-wedged.yaml` completes via `raw_action` dig alone. Unit tests for
reach refusal and for `control` releasing its state on abort.

---

## 3. Scaffold blocks into the survival policy

### Today

`STANDARD_SCAFFOLD_ITEMS = ["dirt", "cobblestone", "netherrack", "basalt"]` in
[movement-policy.ts](../../src/navigation/mineflayer/movement-policy.ts) is
imported by six consumers: navigate (stock reporting and placement filter),
disposal-hole, blast-barrier, fire response, footing response, and the
movement filter itself. The fire response already extends the list ad hoc with
`cobbled_deepslate` and `stone`, which shows the list is wrong in the
deepslate layer and in the End.

### Change

- Add `navigation.scaffold_blocks: string[]` to `navigationPolicySchema` in
  [contract.ts](../../src/survival/policy/contract.ts), default
  `["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "basalt", "end_stone"]`,
  ordered by preference (cheapest first). Validate against the block registry
  and cap the length (16).
- Every consumer reads the list from the policy snapshot instead of the
  constant. Keep the constant only as the default value. Navigate's `scaffold`
  boolean stays; its description says "carried blocks from the policy's
  scaffold list".
- `set_survival_policy` description gains the new field. Policy paths and
  `SURVIVAL_POLICY_PATHS` update automatically from the schema; confirm arrays
  survive `flattenPolicyLeaves` (today leaves are string/number/boolean, so
  the override store needs an array case or a comma-joined string form).
- Remove the fire response's private extension.

### Prove

Policy unit tests for set/clear of `navigation.scaffold_blocks`. Fixtures:
`scenarios/flat/pathfinder/pillar-tower.yaml` variant with only
`cobbled_deepslate` carried, and an End fixture with only `end_stone`, both
required to scaffold. Existing evidence catalog fixture picks up the new field.

---

## 4. Water-bucket fall save and Baritone-style bucket drops

### Why one module, not two

The emergency reflex ("I am falling, save me") and the planned movement ("I
will drop 20 blocks on purpose because I carry a bucket") both need the same
three things: predict the landing cell and arrival tick from current velocity,
place water on the landing block at the right moment, then scoop it back. That
prediction and placement logic lives once, in a shared module (proposed
`src/world/water-landing.ts`), with the reflex and the pathfinder movement as
two callers. Baritone's `MovementFall` is the parity target: a fall over three
blocks is legal when a water bucket is carried, water is placed before impact,
and the bucket is refilled afterwards.

### Observe first

The footing reflex ([reflexes/footing.ts](../../src/survival/reflexes/footing.ts)
and [responses/footing.ts](../../src/survival/responses/footing.ts)) already
tracks impulses and steers toward a landing support, and can extend the floor
with a scaffold block. Measure, in fixtures, at what fall heights and
velocities it fails today with only a bucket carried, and how many ticks of
warning it gets between leaving the ground and impact:

- Drop heights 5, 10, 20, 40, 80 blocks, starting from rest.
- The same heights with a horizontal knockback impulse (the
  `drop-knockback-landing` pattern).
- A drop into a one-wide hole (placement must hit the exact column).
- A drop whose landing block is not placeable (slab, fence, water already
  there, lava).

### Change

- Shared module: `predictLanding(entity, world)` returning the landing cell,
  ticks to impact, and whether it is waterable; `placeWaterBeforeImpact` that
  looks down, pours when the landing block enters reach (about 4.5 blocks,
  so with terminal velocity near 3.9 blocks/tick this is one to two ticks of
  margin, which is why the pour must be armed early and fired on a tick
  callback, not awaited through the action loop); `recoverWater` that scoops
  the source after landing and verifies the bucket is full again.
- Reflex: a `fall` branch in the footing reflex that chooses water over
  scaffold when the fall would deal damage (over 3 blocks after feather
  falling), a water bucket is carried, and the landing block is waterable.
  Falls short enough for the existing scaffold extension keep that path.
  Policy toggle `navigation.bucket_fall_save` (default true) alongside the
  scaffold list.
- Pathfinder: a `fall` movement in the catalogue that permits any drop height
  when a water bucket is carried and the landing is waterable, costed above a
  normal drop, with execution delegating to the shared module. It gets its own
  policy flag `navigation.bucket_drops` (default true) rather than riding on
  the `scaffold` boolean, so the two can be tuned apart.
- Report: the navigation evidence gains `bucketDrops: {count, waterRecovered}`
  and the reflex logs a `survival_receipt` with predicted vs. actual impact
  tick.

### Prove

`scenarios/flat/survival/bucket-fall-*.yaml` for each height and impulse
above, goal `health: 20` and bucket full at the end;
`scenarios/flat/pathfinder/bucket-drop-route.yaml` where the only route under
the time limit is a 15-block drop. Unit tests on `predictLanding` from recorded
physics lines.

---

## 5. `destroy_end_crystal` weapon argument and melee measurement

### Today

[contract.ts](../../src/actions/destroy-end-crystal/contract.ts) takes only
`entity_id`; [end/execute.ts](../../src/survival/responses/end/execute.ts)
shoots whenever a bow and arrow are carried and only falls back to melee when
they are not. Forcing melee means dropping the bow, which the driver did during
the last run.

### Change

- Input `weapon: "auto" | "bow" | "melee"` (default `auto`, today's behaviour).
  `bow` with no bow or arrow refuses up front with a named outcome; `melee`
  skips the shot branch entirely and goes straight to `climbToCrystal`.
  Still subject to `combat.melee` and `combat.bow` policy flags, which win.
- Melee measurement. The result today carries `attacks`, `shot`, `destroyed`
  and health before/after. Add to the checkpoint and final evidence:
  - climb: scaffold blocks placed and recovered, cage blocks dug, time from
    start to first swing, highest feet Y reached;
  - the swing: attack count, whether the swing was made from the planned
    stance cell, distance to the crystal head at the swing;
  - the blast: blast cover cell used, health lost to the explosion, whether
    the return to the start cell completed and how long it took;
  - abort reasons per phase (`stance_unreachable`, `cage_uncleared`,
    `no_blast_cover`, `dragon_contact`).
- Progress markdown shows the phase and those counters while pending.

### Prove

Coverage now lives in [crystals-mixed.yaml](../../scenarios/default/end/crystals-mixed.yaml),
which passes `weapon: melee` on cages while carrying a bow, and
[crystals-bow.yaml](../../scenarios/default/end/crystals-bow.yaml), which passes
`weapon: bow` throughout. Assert the new evidence fields
are present and consistent (attacks ≥ 1 on a melee success, scaffold placed =
scaffold recovered when the return completed).

---

## 6. Portal entry out of `navigate`

### Today

`navigate` carries `destination_dimension` and `allow_low_supplies`, and about
two hundred lines of [navigate.ts](../../src/actions/navigate/navigate.ts)
plus [portal-policy.ts](../../src/actions/navigate/portal-policy.ts) and
[portal-entry.test.ts](../../src/actions/navigate/portal-entry.test.ts) exist
only for the portal case.

### Change

- Two new resumable actions, `enter_nether_portal` and `enter_end_portal`,
  each taking the portal block `x, y, z`, `allow_low_supplies`, and reusing the
  route and positioned-arrival logic by lifting it into a shared
  `src/actions/portal-entry/` module that `navigate` no longer imports.
- `enter_end_portal` adds a respawn guard: refuse unless the bot's respawn
  point is within `respawn_within` blocks of the portal (default 128), unless
  `allow_distant_respawn: true`. The respawn point comes from the spawn
  position packet Mineflayer exposes as `bot.spawnPoint`; verify in a fixture
  that sleeping in a bed updates it, and that a missing bed falls back to world
  spawn and is reported as such in the refusal.
- `navigate` drops `destination_dimension` and `allow_low_supplies`; naming an
  active portal cell without intent keeps today's
  `NAVIGATION_PORTAL_INTENT_REQUIRED` refusal but points at the new actions.
- The supply warning moves with the portal module. Return-to-Overworld stays
  exempt.
- Docs: tools.md, the survival README's expedition notes, and the evidence
  catalog fixture.

### Prove

Move `portal-entry.test.ts` beside the new module. Fixtures in
`scenarios/flat/portal/` for: nether entry, nether return, end entry with a bed
next to the portal, end entry refused with a distant bed, end entry forced
with `allow_distant_respawn`.

---

## 7. Item pickup and death recovery

### Today

Item pursuit exists only inside navigation goals (the `item-pickup-*` and
`moving-item-pursuit` pathfinder fixtures) and inside `hunt_mob`'s drop
accounting. There is no tool to say "go get those items". Deaths are logged as
`player_death` events with a cause but the position is not retained in a
queryable place.

### Change

- Record the death position and dimension on the `player_death` event and in
  `bot_status` as `last_death` (position, dimension, time, cause).
- New resumable action `pick_up_items` with:
  - `item` (optional registry name) to take only that item;
  - `x, y, z, radius` (optional centre and radius, default: around the bot,
    radius 8, cap 32);
  - `recover_death_items: true`, which sets the centre to `last_death` in the
    current dimension, radius 16, and refuses when there is no recorded death
    in this dimension or the death was more than five minutes ago (items have
    despawned).
  - Walks to each observed item entity nearest-first using the existing item
    goal, waits for the pickup packet, and reports what was gained, what was
    seen but not reached, and inventory slots left.
- Progress: items collected / items observed, current target, distance.

### Prove

`scenarios/flat/pathfinder/item-pickup-area.yaml` (scattered items, some on a
ledge), `scenarios/flat/survival/death-recovery.yaml` (die to fall damage with
`keepInventory: false`, respawn nearby, recover at least 90 % of the kit), and a
refusal test for a stale death.

---

## 8. Combat change reporting in progress

### Today

Navigation progress reports distance, elapsed time and scaffold stock every
wait. Combat progress ([control/combat/progress.ts](../../src/survival/control/combat/progress.ts))
tracks hits, volleys and health but nothing about what the fight cost.
Durability changes are already observed in
[runtime/equipment-events.ts](../../src/runtime/equipment-events.ts) and
surfaced by `view_status` and `read_recent_events`, so the data exists; it is
not folded into the pending-wait summary.

### Change

- Extend `combatProgressSchema` with `arrowsFired`, `arrowsRecovered`,
  `durabilityUsed: {slot, item, before, now}[]`, `shieldBlocks`,
  `foodEaten`, `scaffoldPlaced`, and `weaponChanges: {from, to, reason}[]`.
  Counted from the same packet receipts the projectile snapshot and equipment
  events already use; no new polling.
- Every foreground action that can hand the body to combat (`hunt_mob`,
  `destroy_end_crystal`, `attack_dragon_perch`, `navigate` during a takeover)
  shows the delta since the last wait in `duringWait`, the way navigation
  shows distance covered.
- The settled result of a combat action carries the totals.

### Prove

Unit tests on the progress accumulator with recorded packet sequences. The hunt
fixtures (`skeleton-bones-limited-ammo`) assert `arrowsFired` equals the
starting arrows minus the remaining, and the evidence catalog shows the fields.

---

## 9. Enderman targeting: re-rank during the approach

### Symptom

In the warped forest the bot has run straight past an enderman it could have
fought, chasing one much further away, while no enderman was yet angry at it.

### What the code does today

The pursuit loop in
[hunt-process.ts](../../src/navigation/processes/hunting/hunt-process.ts)
scans loaded matches, ranks them, takes the first, and then commits to one
full `route` toward that entity. Ranking is only rerun after that route
completes or stops. Three things follow from that structure, and each is a
candidate cause to confirm from evidence rather than assume:

- **No re-ranking mid-route.** A closer enderman that walks or teleports into
  the bot's path during the approach is invisible to the selection until the
  route ends. If the selected one keeps teleporting away, the route keeps
  following it (the goal is entity-tracking) and the bot passes everything
  else.
- **Stop counts outrank distance.** `scan()` sorts by how many times a target
  has stopped a route before anything else. One failed approach to a nearby
  enderman (it teleported onto a canopy, say) demotes it below every fresh
  target at any distance for the rest of the hunt.
- **Drop-ground rank outranks distance.** `compareCollectionTargets` in
  [target-selection.ts](../../src/actions/hunt-mob/target-selection.ts) puts
  "supported landing" ahead of "unknown" ahead of "hazard" before distance is
  considered. On warped nylium slopes a near enderman over an unloaded or
  unclassified cell ranks below a far one on flat ground. Only after those
  ties does `compareTargets` weigh reach, visibility and distance.

There is also no notion of a teleport in the ranking: an enderman that just
jumped 30 blocks is scored the same as one that has stood still for a minute.

### Observe first

1. Pull the `enderman` hunts from live incidents and `retargets` from the
   hunt evidence (`targetChanges` with reasons). For each hunt, list in order:
   selected target id, its distance at selection, the nearest matching
   enderman's distance at the same moment, and which of the three ranking
   keys above decided it. A script over the incident JSONL can do this; the
   `physics` and `navigation` lines carry the bot position and the goal
   entity.
2. Reproduce in `scenarios/default/nether/` with the existing warped-forest
   seed (20260906) and the `enderman-nylium-approach` kit:
   - `enderman-bypass-near.yaml`: one enderman 8 blocks away on nylium over an
     unknown cell, one 40 blocks away on flat ground. Pass if the near one is
     engaged first.
   - `enderman-teleport-away.yaml`: the selected target is teleported 48 blocks
     away by the fixture's `tick` commands once the approach starts, while a
     second enderman stands 6 blocks off the route. Pass if the hunt switches
     within a bounded time.
   - `enderman-one-failed-approach.yaml`: the near target stops one route
     (canopy), then returns to the ground. Pass if it is re-engaged rather
     than the far one.
3. Record the decision trace in each fixture header as with item 1.

### Change

Only what the evidence confirms:

- Re-rank during the approach: the pursuit route gets a `reconsider` hook
  that runs the scan every N ticks or on any `entity_teleport` for a matching
  species, and cancels the current route when a candidate beats the selected
  target by a margin (distance ratio, not raw blocks, so a 30-block chase is
  abandoned for a 6-block contact but a 10-block one is not for a 9-block
  one). The switch is reported through `onTargetChanged` with reason
  `"closer target during approach"` or `"selected target teleported"`.
- Make distance the first key inside a stop-count band rather than after
  drop ground, or cap how far drop-ground preference may reach (say, it only
  wins within 1.5× the nearest candidate's distance). Unknown ground within
  reach should be resolved by looking, not by walking to a different mob.
- Decay stop counts: a stop older than a fixed time, or a target that has
  since moved more than a few blocks, drops back to zero so one bad approach
  does not blacklist the closest enderman.
- Neutral-mob provocation stays as it is in
  [threats.ts](../../src/survival/perception/combat/threats.ts); this item is
  about which one to walk to, not whether it is hostile.

### Prove

The three fixtures above pass; `enderman-nylium-approach`,
`enderman-six-pearls-rate` and the slope variants do not regress on pearls
per minute. Unit tests on the ranking function with recorded candidate sets
from the observe step, and on the reconsider hook cancelling a route on a
synthetic teleport packet.

---

## 10. Tool tier tracking in progress, and tool loss as an outcome

### Today

[runtime/equipment-events.ts](../../src/runtime/equipment-events.ts) already
observes low durability and the break status packet, and writes
`equipment_low_durability` and `equipment_broken` events. `navigate` reports
only `missingDigTools` (shovel, pickaxe, axe absent at the start) and never
looks again. No action reports "best pickaxe carried: diamond" or notices
when that changes mid-run. A diamond pickaxe that breaks halfway through a
dig-heavy route leaves the bot finishing with a stone one, or bare hands,
and the result says nothing about it.

### Change

- **Tool inventory snapshot.** One function in `src/world/` (proposed
  `tool-tiers.ts`) that reads the inventory and returns, per tool class
  (pickaxe, shovel, axe, sword, hoe, shears, bow, shield, bucket kinds), the
  best carried tier (wooden, stone, iron, golden, diamond, netherite, or
  none) with its remaining durability. Tier order is the registry's material
  order, not a hand-written list. Include armour as a second table for the
  same reason.
- **Standard progress field.** Every foreground action's progress and settled
  result carries `tools: {class, tier, durabilityLeft}[]` in the same slot the
  navigation stock report uses today, and `duringWait` shows only the
  changes since the last wait: `pickaxe: diamond → stone (diamond pickaxe
  broke)`, `shovel: iron → none`, `sword durability 40 → 12`. This reuses the
  item 8 plumbing; navigation, collection, building and hunting all show it.
- **Tool loss as an outcome.** Actions that declared a tool need at the
  start (navigate with `dig`, `collect_block`, `build_structure`, the mining
  process) take a `required_tool_tier` guard: if the best tier for a class
  they are using drops below the tier they started with, the action stops at
  the next safe step and settles `partial` (progress kept) with a named
  outcome such as `[TOOL_TIER_LOST] diamond pickaxe broke at 41,12,-7; stone
  pickaxe remains`. Losing the last tool of a class needed for the route is
  `failed`, not `partial`, when nothing further is reachable without it.
- **No flag on navigate.** Navigation always stops on tier loss. Re-issuing
  `navigate` with the same target costs nothing and loses nothing, so the
  model decides whether to carry on with the worse tool by simply calling
  again; a `continue` option would only hide the event. The result names the
  position and the remaining tools so that call is easy to make.
- **Flag only where stopping loses work.** `collect_block` and
  `build_structure` hold partial progress that a fresh call cannot resume
  cheaply (a half-cleared vein, a half-placed wall), so they take
  `on_tool_loss: "stop" | "continue"` (default `stop`). The mining process
  inherits whichever the calling action passed.
- **Safe step.** Stopping mid-route must leave the bot on observed ground,
  not on a half-dug staircase or in water; reuse the cancellation stop point
  that `cancel_foreground_action` already relies on.
- **Bot status.** `bot_status` gains the tool table so `view_status` and SQL
  show it without an action running.

### Observe first

Pull `equipment_broken` events from the live SQLite and match each to the
action that was running and how it ended. That gives the baseline: how often
a tool broke inside an action and what the result claimed. Also check how
the mining process behaves today when the pickaxe breaks mid-dig (does it
punch, switch to the next pickaxe, or stall).

### Prove

Unit tests for the tier snapshot and the change formatter. Fixtures:
`scenarios/flat/pathfinder/dig-route-pickaxe-breaks.yaml` (diamond pickaxe
with 5 durability, a stone one in the bag, long tunnel route) settling
`partial` with the tool-loss outcome, then completing on a second `navigate`
to the same target; a `collect_block` variant that settles `partial` by
default and completes with `on_tool_loss: continue`, plus its last-tool
`failed` case; the evidence catalog shows the tools field on every action.

---

## 11. Dripstone handled by the pathfinder, not the escape hatch

### Today

Nothing in `src/` names `pointed_dripstone`. The block falls through the
generic geometry classification, and the one fixture
([dripstone-stairs.yaml](../../scenarios/flat/pathfinder/dripstone-stairs.yaml))
only proves that a rising passage digs tips out rather than stepping on them.
The mining process refuses to dig unless the body is on the ground or in
water ([mine-process.ts](../../src/navigation/processes/mining/mine-process.ts),
the `onGround` gates around lines 508, 538 and 561). A stalagmite tip is a
narrow collision box; a body balanced on it, or wedged between a tip and a
wall, can report `onGround: false` while going nowhere, and every dig is then
refused for footing while every route is refused for lack of a standable
start cell. That is the wedge: not "cannot mine in the air" but "physics says
air, so nobody will act".

### Observe first

1. Find the live incident: the last `physics` line before the stall, with
   `onGround`, velocity, the feet cell and the support block. Confirm which
   guard refused (mining footing, `collect_block` target validation, or
   `navigate` start-cell validation) from the action call log.
2. Reproduce in `scenarios/flat/pathfinder/`:
   - `dripstone-wedged.yaml` (shared with item 2): bot on a stalagmite tip
     inside a one-wide pit, asked to navigate out, then to collect the tip.
   - `dripstone-drop-onto-tip.yaml`: a two-block drop that lands on a tip;
     records whether the landing counts as arrived, damages, or leaves the
     body sliding off.
   - `dripstone-ceiling-stalactite.yaml`: stalactites in the head cell of a
     corridor the route must pass, so the head-cell preparation has to dig
     them.
   - `dripstone-falling-stalactite.yaml`: digging the block a stalactite hangs
     from drops it on the bot (a dropped stalactite does fall damage); the
     dig planner should avoid standing under it or dig the tip first.

### Change

- **Classification.** Treat every `pointed_dripstone` state as *not* safe
  support and *not* a standable top, whatever its thickness, so no route ever
  plans to stand on one; as an obstruction it is cheap to dig (hardness 1.5,
  any tool). Stalactites are also "falling" for the purposes of
  `hasUnstableFallingSupport`-style checks: never dig the block holding one
  up while standing beneath it.
- **Footing when the body is on one anyway.** The mining and navigation
  start-cell checks accept "standing on a dripstone tip" as supported when the
  vertical velocity has been zero for a few ticks, and the mining process is
  allowed to dig the block beneath or beside the feet in that state. This is
  the general fix for narrow supports (fence tops, wall tops, lightning rods,
  end rods) and should be written that way, keyed on the observed support
  block's collision shape rather than on the dripstone name.
- **Route recovery from a wedge.** When the search finds no standable start
  cell, the route planner tries a one-cell "unwedge" prelude: dig the
  non-solid support or the adjacent tip, then plan from the resulting cell.
  Baritone's equivalent is that it never refuses to start; it prices the
  current cell like any other.
- **Telemetry.** The `physics` line carries the support block's collision
  shape class so the next stall on a narrow block is obvious.

### Prove

The four fixtures above pass with `health: 20` and `completion`;
`dripstone-stairs` does not regress. Unit tests: classification for every
`pointed_dripstone` state, the narrow-support footing rule from recorded
physics lines, and the unwedge prelude on a synthetic wedged world.

---

## 12. Smelting leaves one item uncooked

### Symptom

Every smelt of N items comes back with N−1 cooked and one raw item back in
the bag. The furnace and its contents are collected before the last item
finishes.

### What the code does today

[smelt-item.ts](../../src/actions/smelt-item/smelt-item.ts) inserts the
input and fuel, then polls the window every 100 ms until the output slot
holds the requested count **or** a wall-clock deadline of
`count × 10 s + 5 s` expires. On expiry it takes whatever output exists, the
`recover` step pulls the remaining input and fuel back out, the furnace is
closed, and when the furnace was a temporary workstation it is dug up. A
furnace cooks one item per 200 ticks, which is exactly ten seconds only when
the server holds twenty ticks per second. Any tick lag stretches every item,
the stretch accumulates across the batch, and the fixed five-second slack is
gone by the end of the last item. The deadline lands while item N is mid-cook,
so the raw input is recovered and the result says `partial` with the timeout
outcome. The bigger the batch and the busier the server, the more reliably
it happens, which is why it reads as "always one".

The five-second slack also has to absorb the tick after insertion before the
furnace lights, and the window round-trips for the two `put` calls, so even
an unloaded server has almost no margin on a long batch.

### Observe first

Confirm the mechanism before changing the loop, since a second cause is
possible: the mineflayer furnace window's `outputItem()` count can lag the
server's set-slot packet, and the deadline could fire between the last cook
finishing and the client learning about it.

1. In the live SQLite, list `smelt_item` calls with `produced = requested − 1`
   and their elapsed time against `requested × 10 s`. If elapsed clusters at
   the deadline, the deadline is the cause.
2. Fixture `scenarios/flat/craft/smelt-batch-lag.yaml`: smelt 16 raw iron in
   a placed furnace with the server tick rate held low (the fixture's `tick`
   commands can `tick rate 16` on 1.21.4). Assert 16 ingots and zero raw iron
   back. Run the same fixture at normal tick rate as the control.
3. Fixture `smelt-temporary-furnace.yaml`: the same batch through a temporary
   workstation the action places and collects, to check the collection order
   as well as the wait.

### Change

- **Wait on furnace state, not the clock.** The furnace window exposes cook
  progress and remaining fuel. Completion is `input slot empty` and
  `progress = 0` and `output count = requested`. Give up only when progress
  has not advanced for a bounded stall window (about fifteen seconds, longer
  than any single cook) or when fuel is exhausted with input still present,
  and say which in the outcome. Keep an outer safety deadline of several
  times the nominal cook time so a dead server still settles, but never let
  it fire while progress is still moving.
- **Collect only an idle furnace.** `recover` and the temporary-workstation
  pickup run only after the completion condition or a stall verdict, never
  on a mid-cook deadline. The pickup also waits for the output to have been
  taken and confirmed in inventory.
- **Report the partial honestly.** When the stall verdict does fire, the
  result names cooked, raw recovered, fuel recovered, and the observed
  progress at the moment of giving up, and the raw count in the result must
  match what came back to the inventory.
- **Progress while pending.** The pending-wait summary shows cooked so far,
  the current item's progress, and fuel left, which is the item 8 plumbing
  again.

### Prove

The two fixtures above pass at low and normal tick rate with zero raw items
returned. Unit tests drive the wait with a fake window whose progress
advances slower than ten seconds per item and assert the loop does not give
up, and one where progress freezes and assert the stall verdict names it.

---

## Cross-cutting

- Every new tool and field appears in `docs/mcp/tools.md`, the action catalog
  test, and `scenarios/flat/evidence/action-catalog.yaml`.
- Run groups sequentially with two workers, per `docs/survival/testing.md`.
- Keep observation notes in each fixture's header so the next reader sees why
  the fixture exists and what it looked like before the fix.
