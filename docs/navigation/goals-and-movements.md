# Goals and movements

Goals state the destination condition for a route. Movements define the physical transitions available to reach it.

The planner in [search/search.ts](../../src/navigation/search/search.ts) queries goals for satisfaction and heuristics. It queries the catalogue in [movements/catalogue.ts](../../src/navigation/movements/catalogue.ts) for candidate steps out of each state.

## Goals define what satisfies arrival

Every goal implements the [`Goal`](../../src/navigation/goals/goal.ts) interface in [goals/goal.ts](../../src/navigation/goals/goal.ts). It takes a live [`NavigationObservation`](../../src/navigation/world/world.ts) and freezes an immutable snapshot. The snapshot provides an `isSatisfied` predicate, an A* distance heuristic, and a revision string that changes whenever dynamic targets move.

The factory functions in [goals/index.ts](../../src/navigation/goals/index.ts) construct standard goal types:

| Goal factory                                                                          | Satisfied when                                                                                     | Common use                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`exactBlockGoal(target)`](../../src/navigation/goals/index.ts)                       | The bot's feet stand precisely on the target coordinate.                                           | Standing at an exact station or button.                                                         |
| [`nearGoal(target, range)`](../../src/navigation/goals/index.ts)                      | 3D Euclidean distance to the target block is within `range`.                                       | Approaching a chest, workbench, or bed.                                                         |
| [`nearXzGoal(target, range)`](../../src/navigation/goals/index.ts)                    | 2D horizontal distance in the XZ plane is within `range`.                                          | Moving into an area without constraining vertical level.                                        |
| [`advanceGoal(start, heading, distance)`](../../src/navigation/goals/index.ts)        | The feet have gained at least `distance` blocks along `heading` from `start`, wherever that lands. | Frontier exploration legs, so a hop over lava or into rock is walked around rather than forced. |
| [`occupyGoal(target, levels)`](../../src/navigation/goals/index.ts)                   | The bot's feet occupy the target cell or up to 2 or 3 cells below it.                              | Mining blocks, where arriving and breaking are the same act.                                    |
| [`anyGoal(goals)`](../../src/navigation/goals/index.ts)                               | Any active goal in the provided array is satisfied.                                                | Collecting whichever dropped item is nearest.                                                   |
| [`customGoal(revision, isSatisfied, heuristic)`](../../src/navigation/goals/index.ts) | The custom satisfaction predicate returns true.                                                    | Task-specific spatial objectives.                                                               |
| [`nearEntityGoal(entity, range)`](../../src/navigation/goals/index.ts)                | Distance to the observed entity's current block position is within `range`.                        | Following a wandering mob or player.                                                            |
| [`safeFromEntitiesGoal(entities, range)`](../../src/navigation/goals/index.ts)        | Distance from every observed threat entity is at least `range`.                                    | Tactical retreat away from hostiles.                                                            |
| [`itemPickupGoal(entity)`](../../src/navigation/goals/index.ts)                       | The bot's feet occupy the item's cell or the cell directly below it.                               | Gathering floating item entities within pickup range.                                           |

## Heuristics estimate distance in execution ticks

The search heuristic evaluates travel costs using execution ticks rather than Euclidean block distances. Blocks along different axes require different physical times to traverse:

- [`HORIZONTAL_TICKS_PER_BLOCK = 4`](../../src/navigation/goals/index.ts): Standard sprinting speed covers one horizontal block in four ticks.
- [`ASCENT_TICKS_PER_BLOCK = 8`](../../src/navigation/goals/index.ts): Climbing or jumping up a block requires eight ticks.
- [`DESCENT_TICKS_PER_BLOCK = 4.5`](../../src/navigation/goals/index.ts): Falling descends at roughly four to five ticks per block.

Descent costs more than horizontal travel. Pricing descent lower than horizontal travel would make hovering directly above a target look cheaper than dropping to it. That inverted gradient once led tree-canopy navigation to abandon low-ground targets.

The function `ticksToReach` in [goals/index.ts](../../src/navigation/goals/index.ts) sums the axis-scaled displacements. This estimate is greedy rather than strictly admissible. It guides A* toward the goal quickly without generating sprawling search frontiers.

## The movement catalogue defines physical transitions

The catalogue in [movements/catalogue.ts](../../src/navigation/movements/catalogue.ts) generates legal physical edges from a planning state. Each edge specifies required preconditions, physical operations, predicted world effects, and cost breakdowns in [movements/movement.ts](../../src/navigation/movements/movement.ts).

The catalogue recognises eleven distinct movement kinds:

| Movement kind | Base ticks | Transition geometry and requirements                                                          |
| ------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `walk`        | 5          | Horizontal traverse to an adjacent supported cell.                                            |
| `sprint`      | 4          | High-speed horizontal traverse requiring adequate food and lookahead clearance.               |
| `step_up`     | 8          | Ascending one block up onto a solid block or placed scaffold.                                 |
| `pillar`      | 12         | Placing a scaffold underfoot to jump up one vertical block.                                   |
| `jump`        | 12         | Crossing a two-block air gap between solid ground.                                            |
| `sprint_jump` | 16         | Crossing a three-block air gap while sprinting.                                               |
| `parkour`     | 20         | Crossing a four-block gap, or crossing two to three blocks while gaining one block in height. |
| `downward`    | 6          | Digging the floor block directly beneath the bot's feet to descend straight down.             |
| `drop`        | 6          | Stepping off an edge to fall between one and three blocks onto safe ground.                   |
| `swim`        | 10         | Horizontal travel through water blocks.                                                       |
| `climb`       | 10         | Ascending or descending climbable blocks such as ladders and vines.                           |

### Traversal geometry and clearance checks

The catalogue applies geometric constraints before producing movement edges:

- **Diagonal travel**: Diagonal land movements are generated only when both orthogonal corner blocks are passable. Diagonals cover `sqrt(2)` blocks of distance, so their tick cost is multiplied by `Math.SQRT2` to prevent zig-zag bias.
- **Descending drops**: Drops must land on safe support up to `maximumDrop` blocks below. Landings beneath falling sand or gravel are rejected to prevent the bot from being buried.
- **Gap jumping**: Jumps check vertical headroom across intermediate air blocks. A sprint jump arcs higher than standing height, so cells two blocks above intermediate positions must stay clear.
- **Sprint qualification**: Sprint edges are offered only when player food is at least six, matching Minecraft's physical requirement in [world/observation.ts](../../src/navigation/world/world.ts).
- **What counts as a floor**: Support is judged from a block's collision boxes in [world/block-geometry.ts](../../src/navigation/world/block-geometry.ts): a full-width top within an eighth of a block of full height is a tread, so soul sand and mud are floors and a lower slab is not. Two name-derived traits override the boxes. A `damaging` block (magma, fire, cactus) is never safe support, and a `yielding` block, the big dripleaf, is never a tread at all: its leaf tilts under a standing body within a second and drops it into whatever lies beneath.

## Policy prices and forbids candidate actions

The [`MovementPolicy`](../../src/navigation/movements/policy.ts) interface in [movements/policy.ts](../../src/navigation/movements/policy.ts) controls which transitions are permitted and how costs are weighted.

Base policies configure feature toggles:

- `allowDigging`: Permits breaking blocks to clear paths.
- `allowPlacing`: Permits placing scaffold blocks for bridges and pillars.
- `allowDoors`: Permits opening wooden doors and fence gates.
- `allowSwimming`: Permits traversing water blocks.
- `allowClimbing`: Permits using ladders and vines.
- `allowParkour`: Enables two-block to four-block gap jumps.
- `allowDiagonalAscend`: Enables diagonal step-ups.
- `allowSprinting`: Enables sprint and sprint-jump edges.
- `allowDownward`: Enables straight-down floor digging.
- `maximumDrop`: Maximum safe fall height, defaulting to 3 blocks.
- `placementPenalty`: Extra cost added to each scaffold placement, defaulting to 8 ticks.
- `heuristicWeight`: Tuning multiplier applied to goal heuristics, defaulting to 1.

Decisions evaluate to one of three variants: `"allowed"`, `"prohibited"` with a reason string, or `"penalized"` with an added tick cost.

## Mineflayer policy protects world resources

The factory [`createMineflayerMovementPolicy`](../../src/navigation/mineflayer/movement-policy.ts) in [mineflayer/movement-policy.ts](../../src/navigation/mineflayer/movement-policy.ts) adds live game knowledge to the base policy.

### Crop and hazard protection

Production navigation avoids destroying farmlands and stepping on dangerous terrain:

- **Protected crops**: The policy prohibits breaking crops in `ROUTE_PROTECTED_CROPS`, including wheat, carrots, potatoes, beetroots, melon stems, pumpkin stems, berries, and cocoa.
- **Avoided blocks**: The policy forbids stepping into or directly over blocks in `AVOID_BLOCKS`, including fire, soul fire, cobwebs, lava, and bubble columns.
- **Damaging blocks**: Blocks with contact damage, such as magma blocks, campfires, sweet berry bushes, and wither roses, are rejected as walkable ground in [mineflayer/world.ts](../../src/navigation/mineflayer/world.ts).

### Liquid hazard rules

The policy inspects surrounding blocks with `opensIntoLiquid` before approving a break. Digging is prohibited if it would release adjacent liquid into the route:

- Any liquid block directly above the dig target.
- Any horizontal liquid source block adjacent to the target.
- Any horizontal flowing liquid that does not already flow downward in its own column.
- Liquid beside an empty cell immediately above the target, which the excavation could redirect downward.

Water below a block cannot flow upward. Excavation separately rejects removing
the dry miner's own support above water, and collection requires preparation for
targets over water. This preserves deliberate bucket access through a pocket's
lid from a different, dry stance while preventing a fall through an aquifer roof.

Collection may prepare a refused target by scooping feeding water sources or sealing
water and lava faces with permitted carried blocks. The in-place dig rechecks the
policy after preparation. Starting on dry ground never grants a liquid exception;
without isolation material, collection reports that requirement and takes any
remaining safe targets instead of repeatedly attempting the same wet work.

Existing still-water mining is preserved: a surface swimming stance, or a supported
submerged stance with an open ascent column and the runtime's live air budget, may
admit water around the target. This exception never admits lava. Flowing water at
the working stance requires isolation before mining.

### Terrain preservation and tools

Navigation adds [`TERRAIN_BREAK_PENALTY = 25`](../../src/navigation/mineflayer/movement-policy.ts) ticks to every broken block. This penalty ensures a walking bot uses existing doorways and staircases instead of tunnelling through walls to save a few steps.

Tool selection calls `selectHarvestTool` to pick the carried inventory item that breaks each block fastest. If `requireHarvestTool` is enabled, blocks that cannot be harvested by carried tools are prohibited.

### Scaffold selection

Scaffold placement uses carried items named by `navigation.scaffold_blocks` in the survival policy. Its default is `"dirt"`, `"cobblestone"`, `"cobbled_deepslate"`, `"netherrack"`, `"basalt"`, then `"end_stone"`. The first usable carried, unprotected name wins, so the array is an explicit preference order; unsafe, falling, interactive, liquid, or partial blocks are skipped. The choice is made from the live inventory each time a search starts; within one search the choice is fixed. An empty list disables automatic scaffold placement. A block with an axis, such as basalt, is predicted in the state the placement face produces, since the server aligns it with that face.

## Water-bucket descents

A `bucket_drop` is a separate movement from an ordinary `drop`. The Mineflayer policy offers it beyond `maximumDrop`, up to 80 blocks, when `navigation.bucket_drops` permits it and a full water bucket is carried outside the Nether. It admits loaded safe full-block floors with open air above; slabs, fences, lava, existing water, and both waterlogged and waterloggable supports are outside this capability. A waterloggable floor such as leaves is refused because the pour fills that block instead of placing a source above it, leaving the body to land dry on a floor that still stops it. Ordinary drop policy remains unchanged.

The movement and emergency footing response use the same water-landing owner: equip early, update the landing forecast from observed velocity, pour as the floor enters eye reach, wait for a grounded water landing, then scoop the source. Continuation requires both source removal and restoration of the attempt's full-bucket count. Cancellation, dimension changes, death and disconnect release the owner. Navigation results expose `bucketDrops.count` and `bucketDrops.waterRecovered`; footing receipts expose the predicted and observed impact ticks and water recovery outcome.

The landing forecast conservatively rejects swept body collisions with walls or partial ledges, and unloaded or liquid cells. Emergency storage access uses one atomic hotbar swap; a closed inventory and clear cursor are required. Water recovery requires the attempt's filled-bucket count to return and its source to disappear.
