# Ocean sand shaft

Run `bunx --bun mine-labs run scenarios/default/terrain/ocean-sand-shaft.yaml --client`.

This uses the live world's verified seed `-06163879`, starting at
`(1414.536, 62.3, -90.464)`, and submits one production `collect_block` request:
one sand at `(1414, 59, -91)`, with scaffolding and full-inventory permission.
The driver verifies that the generated target is sand before submitting it.
It does not wait for the swimming bot to stand on dry ground.

The inventory retains mining tools and several carried building materials but
does not reproduce the live bot's full inventory, armor, or enchantments. Mob
spawning and regeneration are disabled to isolate collection. Terrain is native
generation, not a copy of the live world's player edits. No portal navigation is
requested: this is the first sand collection above the intended shaft.

Success requires the sand item, completed request, and health 20 within 90
seconds. A timeout is a failed regression, not an expected success. Every five
seconds the driver reports position, target block, vertical range and navigation
event counts. At 30 seconds it saves an incident; runtime closure saves another.

The 11 September reproduction stayed at one X/Z, bobbed across vertical start
cells, and repeatedly emitted `search_started` with `start_changed`, matching
the live incident. The search invalidates its starting position while swimming
changes that position before a route is committed. This fixture preserves the
failure for a navigation fix; it does not retry collection or force diving.

After the scoped surface-bobbing fix, two replays completed a swim step and
descended to Y=60, then returned `NO_REACHABLE_MATCHING_TARGETS` after 8.4 seconds.
Each had three searches and only one `start_changed`, versus 206 such restarts
by 85 seconds before the fix. The collection goal still fails; keep its success
contract unchanged until the remaining underwater target-access issue is fixed.
