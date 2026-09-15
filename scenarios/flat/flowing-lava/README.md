# Flowing lava obstacle courses

Seven unarmoured Survival courses, with no fire resistance or regeneration.
The digging courses carry only a diamond pickaxe; the others start empty-handed.
Sources feed real native flow. Six courses use the production action runtime;
the recorded-turn replay isolates the production movement actuator and injects
only the initial recorded velocity. Damage and subsequent motion are native.

| Course                                                                  | Condition                                                                                        | Observed result                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Stair turn](step-up-turn-beside-lava-stream.yaml)                      | Three ascents then a west turn alongside a lava stream, reduced from run 17's final lava contact | Passed twice, 20 health, no fire takeover                                  |
| [Stream slalom](stream-slalom.yaml)                                     | Narrow zigzag bridge with four streams beside its corners                                        | Passed twice, 20 health                                                    |
| [Parkour between streams](parkour-between-streams.yaml)                 | Three-block gap through a one-block opening between two streams                                  | Passed twice, real parkour observed, 20 health                             |
| [Lava advances during a dig](lava-advances-during-dig.yaml)             | A contained source is released after landing while navigation digs obsidian                      | Previously died; now withdraws before contact                              |
| [Lava advances during collection](lava-advances-during-collection.yaml) | Release the same source during `collect_block`                                            | Withdraws before contact                                                   |
| [Recorded turn](inherited-stream-turn.yaml)                             | Inject run 17's landing position and velocity before the westward step-up                        | Previously touched lava on the first tick; now brakes and completes safely |
| [Spreading lava arena](spreading-lava-obstacle-course.yaml)             | Three falling flows spread across a clear planned approach in a wide arena with scattered rocks | Fails safety: reaches the goal but touches lava; 2 health remaining in two fresh worlds |

These are small qualification samples, not a general lava-safety verdict. The
stair fixture does not preserve the live route's entire approach or its inherited
velocity. The separate recorded-turn replay reproduces that missing handoff.

Run once from the repository root:

```sh
bunx --bun mine-labs run scenarios/flat/flowing-lava --out .mine-labs/flowing-lava --repeat 1 --jobs 2
```

Watch in Minecraft using the existing spectator workflow:

```sh
bunx --bun mine-labs run scenarios/flat/flowing-lava --client --repeat forever
```

The client dashboard lists the courses in this folder. The static courses use colored
bridges and glass source holders for visibility. Non-bot players are spectators.
Each run starts with fresh health; deaths remain failures even after respawn.

## What counts as success

The driver requires the intended challenge to happen: three step-ups for the
staircase, a parkour step for the jump, and an actual dig plus advancing lava for
the dynamic case. It verifies the authored lava cells before navigation starts.
Passing requires no health loss, burning, or death. Static courses must reach
their destination without a fire-reflex claim. The dynamic digging courses may stop after
a preventive fire-reflex withdrawal. They observe another 340 ticks to detect
later flow or the burn that previously killed the escaped bot. Mine Labs also
checks server-observed health.

The digging stimulus is explicitly an environmental change: the fixture removes
the source gate after the bot's drop. Native Overworld flow then crosses three
cells while the bot digs. It tests response to changing terrain, not whether
navigation should have chosen to break that gate. Existing
[lava-above-excavation](../pathfinder/lava-above-excavation.yaml) covers refusing
a dig that would redirect lava; it also passed in this investigation.

### Spreading lava arena

`spreading-lava-obstacle-course` has an open floor about 80 by 30 blocks.
Three suspended sources sit above the
approach, with scattered rocks beside their landing areas. The first committed
plan triggers removal of the source gates. Lava falls and spreads through native
Minecraft updates; the driver never places lava directly in the bot's path.
The entire straight approach's feet and head cells must be clear at commitment.

One production `navigate` request must reach the far goal with no health loss,
lava contact, burning, or death. Safe withdrawal alone is a failure. The driver
does not resubmit, steer the bot, or require a particular replan count or detour.
It rejects a run that crosses any flow's x coordinate before that flow reaches
the original approach, so racing ahead of the stimulus cannot qualify.

After arrival, observe at least 160 ticks and require all three flows to have
reached the approach and remained unchanged for 160 ticks. A separate cardinal
walking search over the observed floor then verifies that a dry start-to-goal
route remains after full spread. That search only checks the arrangement; its
route is never provided to the bot. Outer walls retain the arena, but there are
no interior corridors and the bot may choose either side of the flows.

Run just this course:

```sh
bunx --bun mine-labs run scenarios/flat/flowing-lava/spreading-lava-obstacle-course.yaml --jobs 1 --repeat 1 --isolated
```

`LAVA_REROUTE_NAV`, `LAVA_REROUTE_FLOW`, and `LAVA_REROUTE_TICK` retain route,
native flow, position, controls, owner, and safety evidence. `LAVA_REROUTE_RESULT`
records the setup checks and full action result; the completion detail stays short.

Physical baseline on 2026-09-13: two fresh worlds reproduced lava contact near
the first stream after navigation replanned alongside it. Both reached the goal
with 2 health and four committed plans. All arrangement checks passed, including
the remaining dry route after spread. The second run also qualified the final
160-tick quiet/arrival window (the first used 80 ticks). This is a failing safety
regression, not a navigation fix. Evidence is under
`.mine-labs/lava-arena-20260913` and `.mine-labs/lava-arena-confirm-20260913`.

## Evidence and attribution

`LAVA_NAV_EVENT` preserves committed plans, step starts, phases, failures, and
classified world changes. `LAVA_NAV_TICK` records actual position, per-tick delta,
controls, body owner, active step, health, and burning. `LAVA_RELEASE` and
`LAVA_ADVANCE` timestamp the environmental stimulus and observed fluid updates.
Native incident JSONL preserves damage types and detailed physics. Use the
driver's `plans` count and event records: the generic client-host summary watches
a separate navigation instance and reports zero searches for this runtime.

Compare those records before attributing a failure:

- **Planner:** the committed step or its required body clearance already enters
  known lava or releases it through an unsafe excavation.
- **Movement controller:** the planned passage is clear, but the actual body
  drifts, overshoots, or hands off momentum into lava.
- **Changing terrain:** an initially usable route or stance becomes unsafe as
  lava advances, and execution does not withdraw before contact.
- **Fire escape:** once contact happens, determine whether the reflex moves out
  promptly and whether the bot survives the remaining burn.

In the original dynamic failure the lava becomes adjacent about 1.5 seconds before it
enters the standing cell. The bot keeps digging. Route invalidation and fire
takeover happen at contact; the first damage has already arrived. This gives a
reproducible pre-contact response gap independently of movement accuracy around
the static streams. The fire reflex now observes newly arriving lava and leaves
a stance that it can flood on the next update, before damage starts. The same
physical control covers navigation digging and collection. Unchanged lava does
not trigger this preventive takeover.

The recorded-turn replay uses the live landing at `(189.493403, -42, -287.338482)`
translated by x=-189 and z=+288. Its first airborne tick reproduced the native
contact to within a millionth of a block. The actuator now cancels lateral coast
on the supported takeoff cell before jumping. `STREAM_TURN_START` and
`STREAM_TURN_TICK` distinguish injected initial state from measured execution.
