# Run 16: enderman knockback after a failed fighting stance

The retained death incident establishes an enderman hit, followed by knockback
while the bot was idle. It does not show combat walking forward off the ledge.
The run remains a death and zero carried Eyes of Ender; no live play was resumed
for this investigation.

## Original recording

Incident `1379b59d-63a1-42f3-b503-e5f94c87ca32` was recovered through the running
EnderSeeker MCP host on 2026-09-09 Sydney time. Its source receipt identifies
revision `d9887b8774a53cb93336cbc250264a098e270066`, dirty fingerprint
`b804479ed5fdb04ca2c6c4acc264d521792ebc2b70354107967a7c24ed4de5cb`, and PID 40760.
It contains 400 physics samples and reports no byte-budget omissions.

The full recording and a smaller departure extract were preserved in
`reports/enderman-ledge-postmortem/run-16-death.jsonl` and
`reports/enderman-ledge-postmortem/departure-excerpt.json` at the repository root.
These copies are outside the host's rotating incident directory.

| UTC, 2026-09-08 | Observed fact                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 15:12:43.582    | Foreground hunt request 191 settled. The earlier estimate that it ended at 15:12:38 was inaccurate.                                        |
| 15:12:43.685    | Reflex encounter 135 returned `target_unreachable`: no supported melee stance. Position `(-128.5344,47,197.6147)`, health 20.              |
| 15:12:44.179    | Native `minecraft:mob_attack` from enderman 16712, with runtime owner `idle`. Health fell from 20 to 17.48. Off-hand was empty.            |
| 15:12:44.227    | Server velocity packet: `(0.265625,0.275125,-0.13675)` blocks/tick. This is eastward/upward knockback, away from the enderman to the west. |
| 15:12:44.246    | Bot airborne at `(-128.2688,47.2751,197.4780)`. All movement controls false.                                                               |
| 15:12:44.709    | Next reflex began at `(-127.3469,46.1701,197.0034)`, already below the shelf.                                                              |
| 15:12:44.711    | Bot hit the enderman while falling. This explains encounter 136's `attacks: 1`; it does not establish a preceding approach route.          |
| 15:12:45.573    | Fire interrupted that engagement at y29.35.                                                                                                |
| 15:12:52.583    | Lava death at y22.                                                                                                                         |

Every sampled movement control is false throughout the departure and the later
airborne swing. The enderman remained on the shelf during the initial fall;
the trace does not require a teleport across the gap to explain it. The first
lava-trigger inventory snapshot contains no shield anywhere, despite the older
kit summary listing one. The supplied post-mortem geometry is consistent with
the observed departure, but the summary's claim that nothing struck the bot is
contradicted by both the damage and velocity packets.

## Where the behavior is owned

- [Combat controller](../../../src/survival/control/combat/controller.ts): pursuit requires
  `hasMeleeKnockbackRoom`. After an approach fails, defending the current stance
  is allowed only when `guarded` and grounded. With no shield, this fight returns
  `unreachable`, then neutralises item use and stops its footing hold.
- [Hostile policy](../../../src/survival/perception/combat/threats.ts): `canDefendHere` treats
  healthy, exposed contact as fightable even after an unreachable result. This
  does not require the shield or safe stance that the controller needs.
- [Hostile contact](../../../src/survival/reflexes/hostile.ts): a failed response
  imposes a one-second cooldown on the same response kind. The original hit
  landed inside that idle interval. New damage does not bypass this check.
- [Supported position controller](../../../src/navigation/execution/supported-position-controller.ts):
  a new hold constructed while airborne has no remembered support. Its advance
  fails until grounded, so the re-engaged combat cannot steer toward the old
  shelf. This is a lifetime limitation, not a failed search for a lava exit.
- [Fire escape](../../../src/survival/positioning/fire-escape.ts): searches offsets ±4 in
  x/z and ±1 in y for water or dry footing with a clear corridor. Without a
  candidate it returns `blocked` before setting movement or jump. It has no
  general swim-to-surface fallback. The original records contain seven completed
  blocked fire-reflex attempts, followed by death.

The recorded fall was not a planned 15-block descent. Reducing `maximumDrop` or
adding an enderman to the ranged-species set does not address this departure.
Also, combat's `stepField: null` excludes hostile pricing; it is not evidence
that the route planner accepted lava as safe support.

The original investigation above predates the repair below. The policy/controller
stance refusal and the lava escape limitation remain separate concerns.

## Footing recovery repair

[Footing recovery](../../../src/survival/positioning/footing.ts) now remembers the
last observed safe support for the lifetime of the connected bot. A native
velocity packet whose projected landing leaves safe ground arms recovery.
Observation does not write controls. Active combat enters `recover_footing`;
the [footing reflex](../../../src/survival/reflexes/footing.ts) claims an idle or
non-combat body through the existing runner. Combat recovery pauses ordinary
footing control and resumes the fight after restoring its weapon and cooldown.

Recovery steers toward the departure support, checks the outgoing trajectory,
and uses the existing verified placement primitive to extend the floor with
carried standard scaffold blocks. It checks attachment, body occupancy and
reach, and confirms a safe grounded handoff before reporting `landed`. The
first two implementation trials both survived actual edge hits. Their incident
recordings show cobblestone placed at `(-128,46,197)` and a safe landing. One
trial caught a subsequent hit with another block at `(-127,46,197)`.

The existing incident JSONL now includes a `footing` snapshot alongside combat
and physics: phase, departure support, incoming impulse, start time, and the
latest placement cell/result. This uses the existing recorder and retention;
there is no new database table or separate telemetry service. Combat-owned
recovery also appears in the existing `combat.execution.phase` field.

Recovery is a nearby floor catch, not a guarantee of surviving arbitrary falls.
There must be a reachable attachment face and enough time to place before the
body passes below the departure floor. Without materials it still steers, but
does not fabricate a landing or a floating block. The current prediction uses
free flight under normal gravity; this work does not qualify special movement
effects or lava swimming.

All four current fixtures provide 64 cobblestone, a sword and armor. The
[skeleton bridge](skeleton-knockback-bridge.yaml) is one block wide with a
bow-equipped native skeleton to its west. The
[magma cube platform](magma-cube-knockback-platform.yaml) uses a large native
cube on the west side of the 3×3 shelf. Every fixture requires native pressure
at the edge, survival without lava contact or descent below y47, and a grounded
finish. Zero-pressure trials fail as unexercised, even if the bot remains safe.

Early skeleton calibration accidentally omitted the bow and is not arrow
evidence. The final fixture explicitly supplies the bow. A medium cube was
killed before contact; the large-cube calibration delivered a native edge hit,
used two catching blocks, and survived while landing a return attack.

### Final qualification (2026-09-09)

Two complete cycles passed **8/8**, followed by a final outcome/telemetry check
with three passes and one unexercised shield trial. That enderman left without
a hit or shield block; the fixture correctly failed its pressure requirement.
Across these twelve trials there were no deaths, lava entries or drops below
the deck. Eleven trials had verified native pressure at a lava edge.

| Fixture                   | Passed | Unexercised | Observed defence                                                                     |
| ------------------------- | -----: | ----------: | ------------------------------------------------------------------------------------ |
| Unshielded enderman shelf |      3 |           0 | Countersteering, catching placement, and ordinary combat/shelter                     |
| Shielded enderman shelf   |      2 |           1 | Native shield block in one trial; an unblocked hit and catching placement in another |
| One-wide skeleton bridge  |      3 |           0 | Native arrows; steering recovery and existing shelter/escape                         |
| Large magma cube platform |      3 |           0 | Native edge hits, one or two catching blocks, then return attacks                    |

Evidence manifests are `.mine-labs/footing-final/footing-evidence.json` and
`.mine-labs/footing-release-check/footing-evidence.json`. They distinguish total
scaffold consumption (which includes ordinary shelter/navigation) from blocks
placed during recovery. They also distinguish recovery from trials where
ordinary defence sufficed. If the encounter cancels because its target leaves
reach, recovery records `cancelled`; combat's existing release still settles
footing. A physical recovery failure returns a failed fight, never a claim that
ordinary combat resumed on safe ground.

`npm test` passed 1,042 tests, including both strict typechecks.

## Three-block-wide surprise-contact comparison

Run from this package:

```sh
bunx --bun mine-labs run scenarios/flat/combat-terrain/enderman-idle-ledge.yaml scenarios/flat/combat-terrain/enderman-shield-ledge.yaml --client --repeat forever --jobs 1 --out .mine-labs/enderman-west-watch
```

The [no-shield fixture](enderman-idle-ledge.yaml) and
[shield fixture](enderman-shield-ledge.yaml) use the same 3×3-block shelf at y47
above a y22–31 lava pool. The bot starts at the recorded run-16 position
`(-128.53437787507164,47,197.61474899858322)`, near the east edge at x=-128.
The enderman arrives on the west side at `(-129.7,47,197.61474899858322)`.
Their identical z-coordinate makes native knockback point east toward the drop.
Both carry diamond armor, golden boots, a diamond sword and 64 cobblestone.
The original failing baseline carried no building material. The shield variant
also equips a shield in the off-hand before the encounter starts.

The shared [driver](enderman-idle-ledge.ts) installs the production runtime and
evidence listeners before summoning a frozen enderman on a distant raised perch
at `(-128.5,57,240.5)`. After observing that spawn and waiting one second, it
checks that the bot is still at the edge. One scripted teleport then places the
enderman on the west side, about 1.17 blocks from the bot without body overlap.
The driver assigns anger before arrival and then enables its AI. The closer
arrival preserves the native-hit stimulus after wider roofs allowed the bot to
finish protection before contact from the earlier 1.97-block start. The short platform restores the missing safe-stance
condition: a three-block knockback corridor cannot simply extend inland as it
could on the earlier nine-block-long platform. The actual controller's response
must establish whether it refuses the stance; the driver does not force refusal.

The teleport destination is an administrative test stimulus, not evidence that
native enderman AI selected it. Every subsequent attack, shield block, knockback
and movement is native. No damage or velocity is injected, and no teleport,
freeze or rescue occurs after release. Both bots initially face the arrival
direction; carrying a shield does not pre-raise it. The twenty-second window
includes delayed damage after combat releases the body.

This is a simplified flat-world construction, not a reconstruction of every
Nether block or carried item. It preserves the original bot position, deep lava
drop and outward attack direction, with more floor width and separated bodies.

The verdict requires an incoming native hit or server-confirmed shield block
while grounded at the east edge (y47, x at least -128.8), and survival without descending below
the shelf or entering lava. The driver preserves the dying body's position
separately from respawn. Merely avoiding all contact does not establish combat
safety, and a fully blocked fight does not fail for taking zero damage. Outgoing
attacks alone cannot satisfy this surprise-hit scenario.

### Verified west-side reproduction before repair

Two unchanged unshielded runs reproduced the fatal chain on 2026-09-09 Sydney
time. Each recorded a real `target_unreachable` stance refusal followed by a
native enderman hit while the bot was idle, still at the original position,
with all movement controls false. Health fell from 20 to 17.48. Native knockback
carried it east off the shelf into lava; a later airborne engagement attacked
once before the fire reflex interrupted it. Both bots died.

| Run directory timestamp (UTC) | Incoming edge hits | Death y |
| ----------------------------- | ------------------ | ------- |
| `2026-09-08T23-24-51-673Z`    | 1                  | 23.07   |
| `2026-09-08T23-25-13-956Z`    | 1                  | 23.11   |

Reports and detailed incident captures are under `.mine-labs/enderman-west-attack/`.
This is a native reproduction of the failure mechanism with non-overlapping
initial bodies and a three-block-wide shelf. It does not claim identical
geometry, hit magnitude, timing or inventory to the original Nether run.
The shield comparison's first trial landed one attack and its enderman
teleported away before an incoming hit or shield block; that trial is
unexercised, not evidence of shield protection. The earlier unshielded launch
that failed to bind its port is a harness error, not a gameplay failure.

### Earlier long-platform surprise comparison (superseded)

The first scripted-arrival comparison on a 3×9 shelf on 2026-09-09 Sydney time exercised one
incoming edge hit in each variant, reducing health from 20 to 17.48. The trace
then observed upward/outward knockback and recovery onto the shelf. Neither
bot entered lava or descended below y47. The unshielded bot landed two attacks
before the enderman left reach; the shielded bot blocked three later attacks,
landed six and killed the enderman. These trials demonstrate the requested
edge-contact stimulus and successful recovery on this wider fixture, not a
reproduction of the original death. Reports are under
`.mine-labs/enderman-teleport-comparison/`.

### Earlier walking-approach comparison (superseded)

The first comparison on 2026-09-09 Sydney time, before moving the bot from
z199.5 to z200.6 at the operator's request, produced:

| Variant   | Native evidence                        | Observed outcome                                                                                                          |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No shield | One landed attack; no received hit     | Enderman teleported away and approach became unreachable. Bot remained at twenty health on the shelf for the full window. |
| Shield    | Six landed attacks; four shield blocks | Enderman killed. Bot remained at twenty health on the shelf for the full window.                                          |

Both terrain-safety verdicts passed. The no-shield trial did not establish
survival under sustained incoming attacks or knockback; the target left after
one hit. These single trials do not establish comparative reliability. Their
reports and incident recordings are under `.mine-labs/enderman-wide-comparison/`.

## Original constrained fixture (superseded)

The first version used a one-block-wide shelf with the enderman overlapping the
bot at the recorded incident coordinates. It isolated a handoff failure but
provided little room for a successful fight. At the operator's request, the
current fixtures above replace that arrangement with a wider platform and
separated starting positions. The results below belong to the old arrangement.

Initial gaze-only calibration trials had no native
damage and are unexercised, not successful safety trials. Subsequent native
angry-enderman trials reproduced lava deaths, including a hit while idle after
an unreachable fighting stance. Per-tick evidence and incident captures remain
under `.mine-labs/enderman-idle-ledge/runs/`.

The final one-block fixture ran twice after allowing armor packets to settle:

| Run directory timestamp (UTC) | Native enderman hits | Result                                          |
| ----------------------------- | -------------------- | ----------------------------------------------- |
| `2026-09-08T15-37-14-498Z`    | 1, health 20 → 17.48 | Unreachable stance, lava entry, death at y22.79 |
| `2026-09-08T15-37-34-265Z`    | 1, health 20 → 17.48 | Unreachable stance, lava entry, death at y22.84 |

Both safety verdicts fail, as expected for an unfixed regression. In these two
trials the first native hit arrived during the initial reflex; its refused
stance released the body before the pending knockback was applied. The original
recording instead has the hit arrive after release. This reproduces the unsafe
handoff and lava death, not an identical schedule of every packet. Scenario
typechecking and documentation verification pass.

## Querying telemetry from the MCP host

Use `query_bot_data` to read without advancing the gameplay-event cursor:

```sql
SELECT event_id, observed_at, event_type, payload_json
FROM events
WHERE event_id BETWEEN 134 AND 146
ORDER BY event_id;
```

```sql
SELECT rowid, reference_json
FROM action_incidents
ORDER BY rowid DESC LIMIT 10;
```

`action_incidents.reference_json` returns the trigger, related request IDs and
the local JSONL artifact path (or a persistence error). Detailed physics rows
live in that file, not a queryable SQL table. The host has no HTTP download route
for historical incident files. `read_recent_events` returns encounter
summaries and advances the unread cursor; it is not the detailed combat trace.

The [incident observer](../../../src/diagnostics/incident-observer.ts) records
physics, controls, combat phases/decisions, nearby collision cells/entities,
navigation, health and native packets into a rolling 20-second, 8-MiB history.
Death and environmental damage automatically save captures, as do disconnect
and runtime close. Captures are not a continuous recording of the entire run.
Artifact defaults are five days / 64 MiB per incident directory; SQL receipts
remain even after files are pruned. The host flags configure those retention values. Copy incident evidence before further runs can rotate it out.

Saved incident receipts identify the JSONL artifact to inspect. Read and preserve
that file before retention removes it; a new capture cannot recover an expired
past window. `/health` exposes recorder counters and write failures, not the
historical trace contents.
