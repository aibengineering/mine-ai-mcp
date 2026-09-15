# Stronghold location and resumption

Run from the repository root:

```sh
npm run scenarios -- scenarios/default/stronghold --repeat 1 --jobs 1
```

The scenario supplies 16 Eyes of Ender in a fresh Minecraft 1.21.4 world,
seed 8674349, with native structures enabled. A dry stone surface isolates
the locator from ocean travel, from the start at x=336 through the estimate
near x=224. The generated stronghold and its portal room
at y=-22 remain untouched. The bot receives no stronghold coordinates as
action arguments and uses no commands or seed lookup.

The driver cancels during the first flight, waits for its passive recorder to
finish, and reopens SQLite. It cancels again after the second bearing and
reopens SQLite again. The next invocation must return an unconfirmed estimate from those two rows.
A locate call without the recommended supplies must stop before travelling;
an explicit override then travels and makes one local refinement throw before
confirming the native portal room. Every observed surviving surface eye must be picked up,
including drops from the cancelled throws; inventory must equal 16 minus three
throws plus the recovered drops. At least one native surface drop is required for pickup
coverage; if both initial eyes shatter, rerun the scenario. The local refinement
may descend below the survey floor before dropping; that underground item need
not be recoverable. Its position is retained separately in the evidence. The independent
Mine Labs goal checks a known generated portal frame, approach distance,
inventory and driver completion. `stronghold-evidence.json` and the persistent
database remain in the run artifacts.

## Reference implementations

The design was checked against AltoClef commit
`af22e3bc2f03dde45da703f5f7535baae18ea486`:

- [LocateStrongholdCoordinatesTask](https://github.com/gaucho-matrero/altoclef/blob/af22e3bc2f03dde45da703f5f7535baae18ea486/src/main/java/adris/altoclef/tasks/movement/LocateStrongholdCoordinatesTask.java)
  records eye start/end positions, uses a perpendicular second throw and
  intersects the rays. It resets the estimate near its destination.
- [GoToStrongholdPortalTask](https://github.com/gaucho-matrero/altoclef/blob/af22e3bc2f03dde45da703f5f7535baae18ea486/src/main/java/adris/altoclef/tasks/movement/GoToStrongholdPortalTask.java)
  tracks portal frames and searches stone-brick chunks near the estimate.
- [minecraft-stronghold-locator](https://github.com/ens-gijs/minecraft-stronghold-locator)
  also describes perpendicular throws followed by a local refinement throw.

Mine AI MCP implements its own geometry and flight observation. It rejects
backward intersections and precision-poor estimates, widens the baseline when
needed, persists measurements, and requires a loaded portal-frame block for
success. A nearly vertical descending eye supplies a local search estimate;
an estimate completes only the estimate phase and never creates the final event. Inventory exhaustion and
navigation or survey failures return the saved evidence for a later call.
