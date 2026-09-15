# Published tools

Every tool offered by Mine AI MCP owns its contract, input validation, and
physical result. Tools are grouped below by the job they perform.

Every settled runtime action output includes `survivalPolicy`: the current revision, the
defaults, the effective policy, every live override with its lifetime and
reason, the automatic response in progress, and any constraint.

Foreground calls require `submission_id`. Supply optional `wait_timeout_ms`
(integer 0–120000) for an initial full result or pending progress, or omit it for
an acceptance handle. Retrieve unfinished work with `wait_for_action` before
submitting another foreground action. Returning the full result automatically releases the gate. See [async usage](async-actions.md).

### `wait_for_action`

Supply `action_id` and `timeout_ms` (integer 0–120000). Returns the full typed
foreground output on settlement, or live progress and changes during
the wait on timeout. Progress and every settled foreground output include the
current best carried tool and armour snapshot. `duringWait.toolChanges` contains
only replacements, acquisitions, losses, repairs, and durability use since that
wait began. Zero polls immediately. Timeout and client cancellation
leave execution running. Its result union is generated from registered actions.

`progress.combatResources` retains confirmed arrows fired/recovered, durability
use by slot, shield blocks, food eaten, scaffold placements, and observed held-item
changes across combat takeovers and resumption. `duringWait.combatResources`
reports each waiter's own interval. Counts remain available when an action ends
partial or failed. Arrow firing currently requires a normal-arrow inventory
decrement, so Infinity shots are not counted.

`progress.reflexActivity` lists survival states occupied during the action:
reflex responses entered, responses a reflex withheld with the exclusion (a
`prohibited` exclusion names the survival policy field), and combat phases, each
with entries and time in state. `duringWait.reflexActivity` reports each
waiter-local interval. Whenever that activity includes hostile or dragon
reflex work, a combat phase, or a policy-prohibited response, the Markdown adds
a **Survival policy in effect** reminder listing the live overrides (or stating
that defaults apply) with the policy revision; settled results also carry the
`survival` status observed at retrieval for the same purpose.

## Survival policy control

### `set_survival_policy`

The survival policy is the one place the model shapes what the bot does on its
own: every reflex reads its rules from here. Fields are grouped by domain,
`navigation` (preferred scaffold blocks and hostile route avoidance), `combat` (engagement, hiding, recovery, retreat, melee, bow, shield, terrain,
health thresholds, tactical budgets) and `food` (`raw`: when uncooked food may
be eaten automatically). New reflex knobs join an existing group or add one.

Use this control while idle or busy. `set` merges the named fields as
overrides, each carrying the lifetime given with it, so an encounter-scoped
combat tweak never disturbs a session-long food setting. `clear` removes
overrides by path, such as `combat.hide` or `food.raw.allow`, and `reset`
restores every default. `expected_revision` comes from `survivalPolicy` in any
reply, and every edit carries a `reason` in the model's own words, kept beside
the override and in the policy's history. Lifetimes are the connected
`session`, the named active `encounter`, an `until` health or carried-item
condition, or `for` a fixed duration. Death, dimension change and disconnect
restore defaults; normal actions never touch overrides.

Changing policy awaits affected physical cleanup. Prohibiting hiding releases
its hold but leaves the shelter in place. Other permitted defence can continue;
fire, breath, and footing reflexes remain independent. See the
[policy contract](../../src/survival/policy/contract.ts) and the
[survival policy guide](../survival/survival-policy.md).

`navigation.hostile_avoidance_multiplier` scales capped hostile proximity
costs during ordinary navigation and evasion: `1` is normal, `2` doubles the
cost, `0.5` halves it, and `0` removes proximity cost. It accepts finite,
nonnegative numbers. Species radii, critical-health exposure cost and engagement
decisions stay unchanged; deliberate combat approaches remain exempt. Each
route search reads the current value; an edit does not force an existing route
to replan. Use the usual lifetimes to make caution temporary.

`navigation.scaffold_blocks` is an ordered list of at most 16 registered block
item names used by automatic navigation, footing, fire escape, blast barriers,
and disposal-hole closure. The first carried name is preferred. The default is
`["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "basalt", "end_stone"]`;
an empty list disables automatic scaffold placement. Scoped overrides and
`clear` work on the whole list.

`food.raw` decides when automatic eating (the hunger reflex and combat
recovery) may spend uncooked food such as beef, porkchop, or potato. By default
it is kept for cooking until hunger is at most 6, where sprinting stops, or
health is below 10 while hunger is under the regeneration bar of 18. Set
`food.raw.allow` to `always` or `never`, or move `hunger_at_most` and
`health_below`. When only raw food is carried the reflex's stand-down premise
names the floor it is waiting for. Explicit `eat_food` requests are never
affected.

## Tools that observe the bot and world

### `view_status`

Use `view_status` to obtain an instantaneous snapshot of the bot's live
state before planning or after physical execution. It accepts no tool-specific
arguments. Success proves the bot sampled its vitals, world time, exact
position, compass heading, carried items, best tool/armour tiers, and nearby entities, while refreshing
the `bot_status`, `bot_inventory`, and `bot_tools` tables in SQLite. Nearby entities are the
players online, the hostiles the combat policy counts within sixteen blocks, every
loaded dropped item nearest first (up to sixteen), and a summary of every loaded mob
species with its count and the nearest one's entity ID, distance and position, at any
distance. Defined in
[src/actions/view-status/contract.ts](../../src/actions/view-status/contract.ts).

The `mobility` section answers what the carried inventory unlocks, which the
stack list alone does not say: a route falls at most three blocks unassisted,
a longer descent is planned only as a water-bucket drop of up to eighty blocks
onto a loaded safe floor, and the same carried bucket is what the footing
reflex spends to save a fall nobody planned. Scaffold placement, which is what
lets a route pillar up or bridge a gap, needs an admitted carried block.

The rendered section is deliberately two lines, because it renders on every
status read: an available movement costs only its count, and the consequence
is spelled out just where something is lost — `no_water_bucket`, or
`water_evaporates_here` in the Nether, or `policy_disabled` when `bucket_drops`
or `bucket_fall_save` is switched off in the survival policy. The structured
`mobility` field carries the full detail either way. These are the planner's
standing limits, not a claim about the terrain: an available drop still needs
a safe landing under it.

The connected runtime also refreshes these two tables automatically after
inventory, equipment, window, and lifecycle events (batched over 250 ms), with
a one-second heartbeat for idle status. External readers can query SQLite
without calling a tool. Check `bot_status.updated_at` for freshness; rows remain
as the last observation after disconnect. Open-container player slots are mapped
back to player-inventory coordinates. The table is current state, not an item history.

The `endFight` section lists every loaded crystal ID and position, loaded
dragon health and phase, a perch-only head-position estimate, and observed
dragon breath clouds. An empty list means nothing is loaded, not that the
dragon or crystals have been killed.

### `view_blocks`

Use `view_blocks` to read blocks without moving. `find` names up to
eight block kinds and lists, for each, the nearest matches across every loaded
chunk with their distance and the blocks above and below; the count found is
reported whatever the `limit`, which defaults to twelve per name. `box` reads every cell
of a small box around a point, drawn as one grid per layer with a legend, up to
nine across and seven high. `cells` reads exact cells. Every block is reported
with its name and whether it is solid, open, or liquid, and a liquid's source or
flowing level. Success proves the report came from the live loaded world; a
name Minecraft has no block for fails the read. Defined in
[src/actions/view-blocks/contract.ts](../../src/actions/view-blocks/contract.ts).

Light levels are not yet published: a native 1.21.4 probe observed changed
glowstone blocks while Mineflayer's cached block-light readings stayed zero,
even though the server's saved chunk contained nonzero light data. Exposing
those cached values as current light would misrepresent spawn conditions.

### `view_frontier`

Use `view_frontier` to render a spatial ASCII map of explored chunks and
identify the nearest unexplored border. Arguments include `perspective`
(`"biome"`, `"surface_water"`, or `"all"`), map dimensions `width` and
`height`, and an optional zoom scale `chunks_per_cell`. Success proves the
server rendered the map from SQLite chunk records and computed the distance and
compass heading to the nearest uncommitted chunk. Defined in
[src/actions/view-frontier/contract.ts](../../src/actions/view-frontier/contract.ts).

### `query_bot_data`

Use `query_bot_data` to inspect detailed world observations, historical
records, container contents, or Minecraft registry facts using SQL. The only
argument is `sql`, which requires exactly one read-only SQLite `SELECT` or
`WITH` statement. Success proves the query executed within safety bounds and
returned matching rows without altering the database. Defined in
[src/actions/query-bot-data/contract.ts](../../src/actions/query-bot-data/contract.ts).

### `read_recent_events`

Use `read_recent_events` to inspect durable game events such as chat
messages, player deaths, and hostile encounters. The primary argument is `limit`
(1 to 100, default 20). Success proves the server returned an oldest-first page
of unread events and atomically advanced the bot's read cursor to the highest
returned event ID. It remains available during foreground execution; its event
cursor is independent of foreground result retrieval. Defined in
[src/actions/read-recent-events/contract.ts](../../src/actions/read-recent-events/contract.ts).

### `view_crafting_requirements`

Use `view_crafting_requirements` to evaluate a recipe tree before
attempting to craft items. The argument is `items`, an array of requested item
names and counts. Success proves the planner analyzed available inventory,
determined required intermediary steps, identified missing leaf ingredients, and
checked whether a crafting table is needed, without modifying inventory. Defined
in
[src/actions/view-crafting-requirements/contract.ts](../../src/actions/view-crafting-requirements/contract.ts).

## Notes

### `note_save`

Save one `note` with required `context` explaining the motivation and circumstances
for remembering it. The host adds the bot identity, UTC `rememberedAt`, dimension,
feet position, and `worldAgeTicks`. Each call appends a note to `main.notes` in the
current world's bot data. Notes survive restarts when bot-data storage is persistent.
Saving uses the foreground task slot. Defined in
[src/actions/note-save/contract.ts](../../src/actions/note-save/contract.ts).

`worldAgeTicks` is the latest server-reported world age, not time of day or personal
playtime. It excludes time while the world is stopped, persists across server
restarts, and still advances when the world ticks without the bot. It is `null`
before the first server time update. At normal speed, 20 ticks equal one second.

### `note_read`

Return the latest `n` notes for this bot, newest first (`n` defaults to 10 and must
be a positive integer). Each result includes all the saved fields. Reads are
available during another action and do not mark, change, or delete notes. There is
no automatic expiry. For older notes or different filters, query `main.notes` with
`query_bot_data`. Defined in
[src/actions/note-read/contract.ts](../../src/actions/note-read/contract.ts).

## Tools that move the bot across terrain

### `navigate`

Use `navigate` to walk, jump, bridge, or dig to an absolute world
location. Primary arguments are `x`, `z`, optional feet coordinate `y` (omit to
target ground level), acceptance `range`, `scaffold` to allow block placement,
and `build` to deliberately scaffold into mid-air. Success proves the bot's
feet arrived within the specified range of the destination.
When digging is enabled, loss of the starting best pickaxe, shovel, or axe
harvest capability stops at Pathfinder's safe cancellation point and returns
`partial` with `[TOOL_TIER_LOST]`. Reissue the same request to continue with the
remaining tool; `navigate` has no continuation flag.

Active portal cells are not navigation destinations. Use `enter_nether_portal`
or `enter_end_portal` with the active portal block's explicit `x`, `y`, `z`.
Both actions wait for the server to position the bot in the destination.
`enter_nether_portal` crosses between the Overworld and Nether;
`enter_end_portal` crosses between the Overworld and End. Entry remains
separate from `activate_portal`.
If the final portal step or the positioned-arrival signal remains absent for
30 seconds, the action settles with `PORTAL_ENTRY_TIMEOUT` and its observations.

An immediate return request made while the bot still occupies its arrival
portal is refused with `PORTAL_ALREADY_INSIDE`: remaining inside can refresh
the native portal cooldown indefinitely. Leave the opening, allow the cooldown
to expire, then call the same portal action for the return.

Entry to the Nether or End returns `PORTAL_LOW_SUPPLIES` before movement
when fewer than **16 auto-edible food items** or **32 regular arrows** are
carried. Food uses the hunger reflex's allowed foods; counts are items, not
stacks or hunger points. The response includes both observed counts. Retry
with `allow_low_supplies: true` to proceed deliberately despite the warning.
Returning to the Overworld is exempt. These are preparation thresholds, not
physical requirements for a portal to work.

For example, `enter_nether_portal({x: 126, y: 63, z: 292})` walks into that
portal and waits for arrival. Add `allow_low_supplies: true` to override its
supply warning.

Before entering the End, `enter_end_portal` requires a personal respawn bed
confirmed by a native sleep event in the current session within
`respawn_within` blocks (default 128). Mineflayer's `spawnPoint` is the world
spawn used by compasses, so it is not used as bed evidence. A loaded confirmed
bed is checked again before entry; an unloaded bed remains an earlier
observation, not proof that the block still exists. Missing, stale, or distant
evidence is refused unless `allow_distant_respawn: true`. Return to the
Overworld is exempt.

Results name the starting and ending dimensions. `remainingDistance` is null
after a dimension change; coordinates in different dimensions cannot supply a
meaningful remaining distance. Unexpected dimension changes on ordinary routes
still fail. Defined in
[src/actions/portal-entry/contract.ts](../../src/actions/portal-entry/contract.ts).

### `locate_stronghold`

Use two calls with the same `search_id` (default `stronghold`).
`phase: "estimate"` (default) records the initial two bearings and returns
success once triangulation provides an approximate X/Z position. Poor geometry
may require a wider baseline and another bearing. It stops before the journey.
The result includes straight-line distance and walking minutes at 4.3 blocks/s;
this is a baseline, not a computed path or terrain-aware ETA.

Prepare for the Ender Dragon: carved pumpkin, bow, 64 regular arrows, 16
auto-edible food items, iron-or-better helmet/chestplate/leggings/boots and
sword or axe, and a shield. Equipped items count. `phase: "locate"` checks this
same checklist and reports missing items before moving. Supply them or set
`continue_without_recommended_items: true` to depart anyway.

The locate phase reuses SQL bearings, approaches the estimate, makes a local
refinement throw (reusing a saved local throw on resumption), then surveys
loaded columns within `search_radius` (128 blocks by default). Locate success
requires an observed `end_portal_frame` and records `stronghold_located`.
Estimate success is explicitly unconfirmed and does not create that event.
This locates the structure; it does not enter it or fill the portal.
Routes may dig but do not scaffold.
An airborne eye keeps being recorded after cancellation; stopping the runtime
retains the samples already received. Defined in
[src/actions/locate-stronghold/contract.ts](../../src/actions/locate-stronghold/contract.ts).

### `explore_frontier`

Use `explore_frontier` to push the boundary of explored territory into
unknown chunks. Arguments are `heading` in degrees (0° North, 90° East, 180°
South, 270° West) and `chunks` to extend (1 to 8). Success proves the bot walked
successive path legs and newly loaded chunk columns committed to SQLite along
that heading. Defined in
[src/actions/explore-frontier/contract.ts](../../src/actions/explore-frontier/contract.ts).

Exploration can detour sideways while advancing that heading. Its scaffold
placement penalty is 80, compared with 20 for ordinary navigation: each placed
block adds the cost of roughly 16 walking blocks, encouraging existing terrain
over long bridges. This is a route preference; necessary bridges remain allowed.

### `build_structure`

Use `build_structure` to make every cell of a structure hold its
block. Unknown block names reject the request before building and return
`structure: null`; they do not produce a completed empty audit.
`on_tool_loss` is `stop` by default and returns partial progress when clearing
wrong blocks loses a required tool tier. Set it to `continue` to keep the same
build running with the remaining tool.
The structure is given as `blocks`, a list of `{x, y, z, block_name}`
up to 256 cells, or as `portal_frame`, the interior's lowest corner and an
axis, which expands to 10 obsidian, four corner support blocks, and six interior
cells that must be air. The supports default to cobblestone; set
`portal_frame.corner_block` to another carried solid block, such as dirt. They
remain in place and do not prevent activation. A cell whose block is `air` is
dug clear rather than placed, whatever `remove_wrong_blocks` says. The action is
a thin contract over the navigation library's build process, which is
Baritone's builder loop: it places and digs what is in reach from where the
bot stands, lowest first, and otherwise routes under one goal of every
workable cell that is re-evaluated as cells are placed, with the cells already
right protected from the route and never spent as scaffold. It never places a
block into its own cells or one that would seal it in; standing inside a
structure it is asked to close, it steps out first. `remove_wrong_blocks` digs
a cell holding the wrong block first. The result is an audit of cells placed,
dug, and still wrong, with the wrong cells grouped by why they were left —
holding another block, nothing to place against, block not carried, would seal
the bot in, or refused — and the materials short. Sending the same structure
again resumes or audits it. Defined in
[src/actions/build-structure/contract.ts](../../src/actions/build-structure/contract.ts).

### `activate_portal`

Use `activate_portal` with `x`, `y`, `z` of an obsidian frame block
(or a Nether interior cell), or an `end_portal_frame` block. It validates the
complete frame and uses carried `flint_and_steel` for a Nether portal, or
`ender_eye` for each empty End socket. End frames must form the twelve-block,
inward-facing ring, and the bot must carry enough eyes for all missing sockets.
The bot stays outside the opening while activating it. Entering is a separate
action.

Success requires observing every interior portal block: the Nether rectangle,
or all nine `end_portal` blocks. An already active portal succeeds without
items. Repeating after cancellation re-reads the world and skips filled sockets;
inserted eyes persist in frame block states, so no additional SQLite record is
needed. Results report portal cells before and after, plus filled End sockets.
Defined in
[src/actions/activate-portal/contract.ts](../../src/actions/activate-portal/contract.ts).

## Tools that gather materials

### `pick_up_items`

`pick_up_items` sweeps currently loaded dropped-item entities. Supply `item` to filter by exact registry name, or `x`, `y`, `z`, and `radius` (maximum 32) to choose an area. `recover_death_items: true` instead uses the retained last death in the current dimension with radius 16. The result reports net inventory gains and distinguishes unreachable items, full inventory, and disappearance without a confirmed gain.

Recovery refuses after five minutes of wall time as a conservative boundary. Minecraft advances a dropped item's despawn age only while its chunk is loaded, so wall-clock age cannot establish that older drops have despawned.

### `collect_block`

Use `collect_block` to mine blocks and pick up their dropped items.
Important arguments are `block_name`, the requested `count` of drops to gather,
optional specific coordinates `x`, `y`, and `z`, and `scaffold` permission.
`on_tool_loss` defaults to `stop`, preserving the observed partial vein when the
best required harvest tier drops. `continue` lets the same request use its
remaining tool; losing the last usable tool still reports the physical stop.
Without coordinates it mines the closest matching blocks it can reach, wherever
they are, including blocks the bot placed itself; navigate to the area first
when a particular deposit matters. The best carried tool for each block is
equipped automatically. The response lists every cell broken with its distance
from where the run started, so the model can see which deposit was mined.

Unless `allow_full_inventory` is true, capacity is checked both at admission
and during collection. Admission asks whether any item the selector could yield
has room; once a drop is on the ground, the check asks whether that item can
enter, so a spare stack of one wood does not keep the bot waiting on a log of
another. If pickups fill the last compatible stack before the requested quantity
is reached, collection releases navigation and reports partial gains with
`INVENTORY_FULL` instead of waiting beside an uncollectable drop. Either way, a
drop the bot has stood in for three seconds without an inventory gain is given
up rather than held until the server despawns it.

A target with water beside or above it is mined; a target with lava against it
is mined once each lava face has been closed with a carried block, so
collecting obsidian means carrying a stack of cobblestone. A target that cannot
be taken says why in numbers — `3 lava faces, 1 block carried` — rather than
naming a policy.

Name the block to break, not the item wanted. `cobblestone` and
`cobbled_deepslate` are the no-silk-touch drops of `stone` and `deepslate`,
which are almost everywhere underground, while naturally placed cobblestone is
structure-bound and most often the walls of a dungeon around a spawner. Asking
for `cobblestone` by name therefore routes the bot to that spawner. Ask for
`stone` when the item is the point; ask for `cobblestone` when those placed
blocks are.

Obsidian is the one block the bot makes rather than finds. Ask for obsidian
while carrying a water bucket and, when no obsidian is loaded, the loaded lava
pools become targets like any other: the route walks to a lip, the bot pours
through the pool at its floor so the water lands in the lava itself, breaks
the rock in the way first when a pool is under a lid, scoops the water back,
and mines what formed. There is no separate cast tool.

Success proves the requested quantity of items entered the bot's inventory
following observed mining and pickup. Defined in
[src/actions/collect-block/contract.ts](../../src/actions/collect-block/contract.ts).

### `collect_mob_drop`

Use `collect_mob_drop` to find and kill loaded mobs of one type for their drops.
Arguments are `mob_name`, the target `drop_name`, and the requested `count`.

A hostile `mob_name` is refused before the pursuit takes a step unless a shield
is carried and `combat.shield` permits raising it. Hostility is the entity
registry's own category, so it covers the species whose narrower `type` field
misreads them - hoglins, phantoms, slimes, magma cubes, ghasts - alongside the
obvious skeletons and creepers; passive quarry is never gated. The refusal is
`HUNT_NO_SHIELD` with termination `shield_required`, and it is re-checked on
every leg, so a shield that breaks mid-hunt stops the next one. Passing
`allow_without_shield: true` admits the same request as a deliberate choice to
take unblocked hits; it is not a fallback to retry the refusal with.
The walk to the chosen mob is the hunt's own navigation process: it selects the
loaded match, preferring estimated supported loot landings over lava, and routes
to contact range with no radius bound — so a mob
sixty-five blocks off is reached, not refused — and gives up on one target after
two stopped routes rather than on the species. Each target is then fought from
contact range through the same combat controller the hostile reflex uses, so a
hunted blaze is met with the shield raised through its fireball bursts and an
enderman is fought from under a two-block roof when one is near; the reflex
leaves a fight the hunt is already fighting alone, and a hostile that reaches
the bot between kills is the reflex's fight, after which the hunt resumes. The
reflex fights, never evades, a mob of the hunted species while health permits
fighting; only the health and creeper rules withdraw from quarry. After
each kill the hunt picks up the requested drop, then whatever else fell, and it
starts by gathering requested drops already lying nearby, which is how a reflex
kill's drops reach the inventory. Combat uses the connected policy's weapon,
terrain, recovery and health permissions. It does not change those permissions
or reset an override when the collection finishes.
When permitted, low health suspends combat for protection and
recovery using carried supplies. A rejected shelter or fighting position is local
to that geometry; a failed construction can withdraw to a different recovery cell.
Exhausted recovery, missing required supplies, exhausted reachable targets, and
execution failures are explicit stopping facts. The action does not obtain new
supplies or explore for unloaded mobs. By default it returns when no loaded
quarry remains. Its evidence lists the quarry the client holds at return,
nearest first, and the drops still lying loaded at return; drops picked up or
gone are counted, not listed. `observe_for_ms` opts into a finite wait in the action, measured
from the first absence; fights and reflex suspension do not renew that window.

`camp_spawner: true` additionally remembers the nearest loaded spawner at
admission and requires a positive `observe_for_ms`. After an absence wait, it
navigates within three blocks of that same source and waits for at most the
same duration there. If already at the source, only the at-source wait applies.
New quarry resumes collection. No quarry at the deadline returns
`observation_exhausted` with partial inventory and the usual handoff evidence.
Each absence episode has those finite waits; this is not a total duration limit
on fights or navigation. Reflex suspension and displacement do not reset either
deadline. The remembered source, phase and deadlines appear in request evidence.
The action does not assume the spawner matches the requested species or that
lighting, space and spawn rules permit spawning. Missing/destroyed spawners and
failed return routes produce `spawner_unavailable` or `spawner_unreachable`.

For example, `{ "mob_name": "blaze", "drop_name": "blaze_rod", "count": 12,
"camp_spawner": true, "observe_for_ms": 45000 }` waits at most 45 seconds away
before returning, then at most 45 seconds at the source without quarry.

The result separates `termination`, explaining collection's end, from `handoff`,
which records observed safety or an unsafe/interrupted withdrawal under the same policy. Success proves
the requested drop entered inventory and a safe handoff was observed; evidence also reports
the combat styles used, the ranged windups met with the shield, the other drops
collected, and every loaded mob the pursuit saw with its position and distance,
so a mob the routes could not reach can be walked to and hunted again. Defined
in [src/actions/hunt-mob/contract.ts](../../src/actions/hunt-mob/contract.ts).

### `destroy_end_crystal`

Incoming dragon body contact may use the shared automatic enclosure and recovery
when hide/terrain policy permits, supported dragon-resistant footing is observed,
and sufficient end stone or obsidian is carried. The same crystal action resumes
after the required health target is reached and the dragon has passed; normal
navigation opens its exit. With recovery prohibited, successful defence can
resume at the engagement health floor without eating or waiting to heal.
Landing uses the existing low approach instead of roofing the prepared head
sightline. Breath or lost cover invalidates the shelter.
Unavailable or exhausted required healing returns `END_SHELTER_STOPPED` with current
health, hunger, and the recovery reason instead of resuming attacks wounded.

Select one loaded crystal with `entity_id`, choose `weapon: "auto" | "bow" |
"melee"` (`auto` by default), and for melee `approach: "staircase" | "pillar"`
(`staircase` by default). Auto preserves inventory-based selection: a
permitted carried bow and arrow are preferred, then melee. Explicit bow refuses
with `weapon_unavailable` before movement when the bow or ammunition is missing.
Explicit melee skips shooting even while the bow and arrows remain carried.
The combat controller approaches a clear bow trajectory outside the crystal explosion radius, draws and fires, and
handles immediate dragon hazards locally. Success requires an observed death
or an explosion at that crystal's position. An unconfirmed shot reports
`shot_missed`; losing sight of an entity is not a death receipt. After a released
shot loses observation, the action returns near the recorded native tower and
waits for fresh server updates. A loaded site verified empty completes the
action; a crystal still present remains eligible for another attempt. The action
does not choose the next crystal. Native firing gaps can be used where a clear
trajectory exists. Bow navigation searches toward observed standing positions
with valid shots, rather than a fixed distance from the tower, and rechecks the
shot after arrival. Melee plans a fixed spiral staircase around the observed tower
and uses the same re-auditing builder as `build_structure`. It counts missing
end-stone blocks before building; `[CRYSTAL_STAIRCASE_SHORTFALL]` reports the
required, carried and additional amounts. Gather the shortfall and retry the
same crystal: completed treads are reused, missing treads repaired, and walking
routes preserve the staircase. Treads attach directly to obsidian where possible;
lower supports bridge the tower's corner gaps. End-stone placement must be permitted by policy.
The tower itself is never mined. On narrow towers the swing comes from the rim
one block below the pedestal's top face, where an intact bedrock or obsidian
pedestal shields the whole body; a guarded tower's one corner bar is the only
block cleared. On wider towers that rim is out of melee reach, so the bot steps
onto the top layer and swings from the disc cell farthest from the crystal that
still reaches it. The pedestal still blocks every blast ray to the lower body
there, and the action reproduces the server's explosion and armor arithmetic
before the swing: it refuses with `[CRYSTAL_BLAST_UNSAFE]` unless the estimated
damage after worn armor, plus a two-point margin, leaves health above
`combat.critical_health` (enchantments are not credited; a live swing in
diamond armor lost 5.7 health against an estimate of 5.3). A live reach and
line-of-sight check precedes every swing. The action then returns to supported
ground within four blocks of where the climb began, leaving the staircase in
place for reuse. `approach: "pillar"` skips the staircase: the route scaffolds
straight up beside the tower with carried blocks from the policy's scaffold list
to the same swing stance, refuses with `[CRYSTAL_PILLAR_SHORTFALL]` when too few
are carried, and digs back down through its own pillar on the return. It is
faster and needs fewer blocks than the spiral but leaves nothing to walk on for
a second visit; the staircase shortfall message quotes the pillar's block count
so a caller can choose. Failures remain explicit. Combat policy permissions
take precedence over the requested weapon. Pending and final evidence records
the crystal phase, chosen weapon, scaffold placement and recovery, cage digging,
time and distance of the first swing, the blast stance with its exposure and
estimated damage, health lost to the explosion, and the measured return to
ground. Route travel never counts as target damage or
survival. Defined in
[src/actions/destroy-end-crystal/contract.ts](../../src/actions/destroy-end-crystal/contract.ts).

End combat actions yield to ordinary hostile defense when another mob threatens
the bot. Such a takeover returns `[HOSTILE_CONTACT]` cancellation to the caller;
after defense releases the body, the caller may select its next action. A
cancelled perch request does not silently start a new perch window.

### `attack_dragon_perch`

Select one loaded dragon with `entity_id`. Call `prepare_dragon_perch` separately
to establish a reusable low staging notch. The attack uses its surface entrance
when the strafing dragon needs a sightline, then attempts the
existing passage below for landing. It
approaches the estimated settled head and swings upward with weapon cooldowns,
and responds to breath, projectiles and observed perched contact geometry.
Navigation can excavate an immediate head stance, using only permitted
dragon-resistant scaffold materials. Active attacking and retreat never repeat
general preparation. Scanning duration does not abort a usable head approach.
Head routes remain low, and jump clearance is checked for actual jumping
transitions so level walking beneath an overhead cloud remains available.
On observed takeoff it withdraws from danger and requires ten consecutive clear,
supported physics ticks before returning control. An incomplete retreat is a
failed action, with damage evidence retained. The call returns after takeoff,
observed dragon death, a physical failure, or caller cancellation. It reports
issued attacks separately from observed health change, time to first damage
from both request admission and observed perch entry, time in each stage,
minimum health and the last concrete attack blocker. Waiting has no action
deadline; a cancelled or lost observation is not a kill. This implements one
perch window, so the caller decides whether to repeat it. Defined in
[src/actions/attack-dragon-perch/contract.ts](../../src/actions/attack-dragon-perch/contract.ts).

### `shoot_dragon`

Select a loaded flying dragon with `entity_id`. Each call attempts at most one
full-charge bow shot from the current footing, then reports observed health loss
or a missed/unconfirmed shot. Repeat calls to keep attacking. It uses the carried
bow and arrows permitted by `combat.bow`, leads the estimated 5-by-3-block body,
checks the curved arrow path, and retains a released shot across interruptions.
Sitting dragons are immune to arrows; use the perch action or wait for takeoff.

`hitbox_margin` defaults to **0.5 blocks**, accepts **0–1.25**, and insets each
face of the predicted body. Larger values require more agreement between recent
motion estimates and conserve arrows by waiting for a steadier or closer pass.
It does not change the 64-block firing limit, swoop detection, or evasion distances.
Sudden turns and arrow spread can still cause misses. After 200 aiming ticks
without a usable shot, the action returns its blocker so the caller can reposition.
Defense can extend that time. Normal nonlethal damage does not clear a stale
native strafe target; bow damage provides a separate way to attack that dragon.

### `prepare_dragon_perch`

Select one loaded dragon with `entity_id` before it lands. While the dragon is
flying, the combat controller excavates one low approach outside the fountain
and opens its sightline to the expected body eye, without swinging. Preparation
creates an outward ascent with permitted dragon-resistant blocks and physically
walks down, up and back down without construction, allowing at most four seconds
per leg. A viewing shaft alone is not readiness. The controller retains the
selected notch across calls for the same dragon and dimension; every route still
checks current terrain and hazards. The call
returns when that staging notch is ready, or early when
the observed landing approach begins, so the caller can immediately start
`attack_dragon_perch`. Progress reports the prepared position, current stage,
and any physical blocker. A stopped preparation reports what blocked it and
never claims that the dragon was attacked or killed. `view_status` reports the
dragon's phase name, its estimated current perched head, and a separate tentative
landing head position. Landing direction can reverse; preparation is not a
guaranteed striking stance or protection from every cloud. A passage obstructed
by standing or jump exposure returns `[PERCH_PASSAGE_CLOUDED]` with coordinates
and advice to wait for clearance or choose another route. Preparation that takes
damage stops after defense instead of repeatedly attempting that excavation.
Defined in
[src/actions/prepare-dragon-perch/contract.ts](../../src/actions/prepare-dragon-perch/contract.ts).

### `use_container`

Use `use_container` to interact with stationary storage containers like
chests and barrels. Key arguments are `operation` (`"inspect"`, `"deposit"`,
`"withdraw"`, or `"organize"`), block coordinates `x`, `y`, `z`, transfer list
`items`, or target `item_order`. Success proves the container opened, the
requested transfer or reorganization completed, and the resulting slot layout
was committed to SQLite. Defined in
[src/actions/use-container/contract.ts](../../src/actions/use-container/contract.ts).

### `use_bucket`

Use `use_bucket` to scoop a water or lava source into a carried bucket,
or to pour a full bucket into one exact cell. Arguments are `action` (`fill` or
`pour`), `liquid` (`water` by default, or `lava`), and for a pour, or for a
fill that names its source, the cell coordinates `x`, `y`, `z`. A fill without
a cell scoops the nearest source found the way mining finds ore, through the
navigation module's exploration primitive: every loaded column is searched, and
when none holds one the bot explores outward for a bounded time before the
result says none was found and leaves the next move to the model. A named cell
is checked before the walk rather than after it, so a wrong cell fails in a
millisecond; a fill named at a flowing cell scoops the source feeding it when
one is within a few cells. Success proves the bot navigated within reach, the
bucket in its hand changed, and for a pour the cell holds the liquid; a pour
also reports how many lava sources became obsidian and how much flowing lava
became cobblestone. A full bucket's ray stops at a solid face and the liquid
lands in the cell in front of it, so a pour needs a face the bot can actually
see from where it stands. To obtain obsidian, ask `collect_block` for it while
carrying a water bucket — casting is part of mining, not of the bucket.
Defined in
[src/actions/use-bucket/contract.ts](../../src/actions/use-bucket/contract.ts).

## Tools that craft and smelt items

### `craft_item`

Set `temporary_workstation: true` to place a carried crafting table, execute the
whole batch at that table, and collect it before returning. This mode requires
a table already in inventory, even if one exists nearby; otherwise it returns
`WORKSTATION_NOT_CARRIED`. The `workstation` receipt records the placed position
and whether pickup was observed. Failed crafting also attempts pickup. If
pickup fails, the call cannot succeed and reports `WORKSTATION_NOT_RECOVERED`.
Cancellation releases control promptly and can leave the table behind.

Use `craft_item` to craft finished goods through the recursive recipe
planner. The argument is `items`, a list of target item names and counts. When
a recipe needs a crafting table and none is within reach, a carried table is
placed on a cell chosen beside the bot and the result says where. If no table
is carried, one is crafted only when the inventory can also fund the requested
batch. `inventoryBefore` remains the original count; `usedForWorkstation`
separately records a carried table spent on preparation. Success
proves the planned recipe batch was executed and the requested items were
observed in the bot's inventory. Each item's `confirmed` says whether the
server sent the count it gained before the action stopped waiting; see
[Why does a receipt say a count was not confirmed?](concepts.md#why-does-a-receipt-say-a-count-was-not-confirmed).
Defined in
[src/actions/craft-item/contract.ts](../../src/actions/craft-item/contract.ts).

### `smelt_item`

Use `smelt_item` to smelt raw ores or cook food inside an empty furnace.
Arguments are `item_name`, input `count`, `fuel_item_name`, and furnace
coordinates `x`, `y`, `z`. Success proves the input and fuel were inserted into
an empty furnace, cooking completed, residual fuel was recovered, and the
finished product entered inventory. Alternatively, omit all coordinates and
set `temporary_workstation: true` to place and recover a carried furnace for
the call. This has the same missing-workstation, cleanup, and cancellation
outcomes as temporary crafting. Recovery uses normal block collection, so a
furnace needs a suitable carried pickaxe. A furnace whose slots could not be
emptied is left intact and reported as unrecovered. Smelting accepts one input
type per call, with `count` selecting the batch size.

The pending checkpoint reports furnace input, buffered fuel, output, current
cook progress, active-fuel progress, and how long cook progress has remained
unchanged. The action does not assume twenty server ticks per second. It stops
when cooking completes, fuel is exhausted with input remaining, cook progress
truly stalls, or the outer safety bound is reached. A partial result names the
cooked output, raw input, and buffered fuel actually recovered, together with
the last observed cook and fuel progress. Slot recovery has its own bounded
settlement, so cancellation or disconnection cannot leave the request waiting
indefinitely. Defined in
[src/actions/smelt-item/contract.ts](../../src/actions/smelt-item/contract.ts).

## Tools that help the bot survive

### `eat_food`

Use `eat_food` to replenish hunger and saturation from carried supplies.
The argument is `food_name`, specifying an exact carried item. Success proves
the item was equipped and consumed through Mineflayer, and reports the observed
hunger, saturation, and inventory change. The result's `confirmed` says whether
the server sent the slot that lost the food before the action stopped waiting;
see [Why does a receipt say a count was not confirmed?](concepts.md#why-does-a-receipt-say-a-count-was-not-confirmed).
Defined in [src/actions/eat-food/contract.ts](../../src/actions/eat-food/contract.ts).

### `drop_item`

Drop named carried items, optionally walking to a named player before tossing
them. Each entry accepts `item_name` and an optional `count`; omitting the count
drops all carried stacks of that item. Worn armor and the off-hand are excluded,
and the held item requires `allow_equipped`. Results report the observed inventory
decrease. Collection and hunting ignore the resulting item entities as targets.
Set `in_a_hole: true` to create a dry, enclosed disposal pit below pickup height
beside the bot. Underground, this can excavate an opening into a tunnel wall
before digging the pit. Existing suitable pits can be reused. The bot stays on
its supporting ground; liquid boundaries, falling blocks, and unbreakable terrain
can prevent preparation. This cannot be combined
with `to_player`. Hole disposal additionally verifies that the tossed items
landed at the bottom; the result includes the hole's bottom coordinates. The
bot then plugs the shaft above the discards with a carried full block (scaffold
material first; never a falling block or a workstation) and walks a few blocks
clear of the pit, so a following `collect_block` or other route does not lead
straight back into it. The result's `holeClosure` reports the block used, how
many were placed, the bot's final distance from the hole, and any reason the
hole stayed open; neither step changes the drop's status.
Defined in [src/actions/drop-item/contract.ts](../../src/actions/drop-item/contract.ts).

### `equip`

Use `equip` to wear armor, hold a tool or weapon, or put a shield in the
off-hand. The argument is `items`, up to six carried item names each with an
optional `destination`; armor goes to its own slot, a shield to the off-hand,
and anything else to the hand unless told otherwise. The result reports what
every equipment slot holds afterwards. Defined in
[src/actions/equip/contract.ts](../../src/actions/equip/contract.ts).

To choose one copy, read the inventory slots and durability in `view_status`
and pass `source_slot`, for example
`{"items":[{"item_name":"shield","source_slot":24}]}`. The slot is checked when
that entry executes; a different item or empty slot fails without selecting a
fallback. Success verifies the selected item's properties in the destination.
Without a source slot, a matching equipped item is kept, otherwise the first
carried match is selected. Earlier entries can move items used by later entries.

### `sleep`

Use `sleep` to skip the night or set the player's respawn point. It
takes no tool-specific arguments. Success proves the bot reached a bed within 32
blocks or placed one from inventory, entered the bed without hostile
interference, and woke when morning arrived or the respawn point was set.
Defined in [src/actions/sleep/contract.ts](../../src/actions/sleep/contract.ts).

### `raw_action`

Use `raw_action` only as a bounded escape hatch when normal actions refuse and
the bot is wedged. Each call owns the foreground body for one attempt and does
not navigate or resume. Choose one operation:

- `look`: give either `yaw` and `pitch` in radians, or an `x`, `y`, `z` point.
- `dig`: give the exact reachable block cell. The held tool is used; digging is
  refused while the body is in lava.
- `place`: give a carried `block_name`, the support block's `x`, `y`, `z`, and
  its `face` (`up`, `down`, `north`, `south`, `east`, or `west`).
- `swing`: omit `entity_id` for one arm swing, or name a loaded entity for one
  attack.
- `use_item`: activate the held item in `hand` or `off-hand` for one tick, then
  release it.
- `control`: hold one control `state` for `ticks` from 1 through 40. Cancellation
  releases that state before the foreground body is returned.

The result reports observed before/after position, heading, inventory, and any
target block or entity. This deliberately bypasses route planning and the
ordinary actions' footing and terrain-policy refusals. Foreground survival
ownership, cancellation, server reach, and the no-dig-in-lava boundary still
apply.

### `place_block`

Use `place_block` to put down one carried block. With `block_name` and
coordinates `x`, `y`, `z` the bot navigates within reach of that exact cell,
verifies an adjacent solid support face, places the block, and confirms the
cell changed. With `block_name` alone it picks the nearest clear, supported
cell within reach of where it stands, which is how to put down a crafting
table, furnace, or chest without knowing the surroundings. A named cell holding
water or lava is filled rather than refused, because vanilla replaces a fluid
cell with the block placed into it; a cell chosen for the bot is always dry.
The result's
`confirmed` says whether the server sent the slot that lost the block before
the action stopped waiting; see
[Why does a receipt say a count was not confirmed?](concepts.md#why-does-a-receipt-say-a-count-was-not-confirmed).
Defined in
[src/actions/place-block/contract.ts](../../src/actions/place-block/contract.ts).

## Tools that manage session control

### `cancel_foreground_action`

Use `cancel_foreground_action` with `action_id` and `reason` to request that
specific objective stop. A necessary reflex can complete safe release; the
objective will not resume. A settled target is an idempotent no-op and an unknown
ID is refused. Wait for the result before replacement work. The MCP contract is
defined in [src/server/async-tools.ts](../../src/server/async-tools.ts).

### `send_message`

Use `send_message` to communicate with other players via in-game public
chat. The argument is `message`, containing the text string to broadcast.
Success proves the message was sent and the bot observed its own chat echo
returned by the server. Defined in
[src/actions/send-message/contract.ts](../../src/actions/send-message/contract.ts).

## Diagnostic tools available only in debug mode

These tools exist only when the host enables debug actions. In host options this
corresponds to `debugExecuteJavaScript: true` in
[src/actions/index.ts](../../src/actions/index.ts), enabled on the command line
via `--debug-execute-javascript` in
[src/server/config.ts](../../src/server/config.ts).

### `debug_set_pathfinder_telemetry`

Use `debug_set_pathfinder_telemetry` to toggle detailed navigation telemetry in
the host process stdout log. The argument is boolean `enabled`. Success proves
the listener attached or detached from Pathfinder events without taking the
foreground action slot. Defined in
[src/actions/debug-set-pathfinder-telemetry/contract.ts](../../src/actions/debug-set-pathfinder-telemetry/contract.ts).

### `debug_execute_javascript`

Use `debug_execute_javascript` to run raw JavaScript against the live Mineflayer
instance when standard tools cannot achieve the task. The argument is `code`,
containing an asynchronous function body with `bot`, `Vec3`, and `console` in
scope. Success proves the code evaluated and returned inspectable text within
output size limits. Defined in
[src/actions/debug-execute-javascript/contract.ts](../../src/actions/debug-execute-javascript/contract.ts).

### `barter`

Use `barter` with an observed adult `piglin_id`, desired `item_name`,
additional `count`, and explicit `gold_budget`. It collects loaded desired drops
before offering gold, including when the budget is zero. Native interaction
offers one ingot at a time to that piglin. An interrupted or unconfirmed offer
still reserves budget; resumption retains the original inventory baseline and
budget. Success requires the requested additional items in inventory. The
receipt reports actual carried gain, observed gold spent, and offers used; it
does not claim that gold loss alone proves a completed exchange. Defined in
[src/actions/barter/contract.ts](../../src/actions/barter/contract.ts).
