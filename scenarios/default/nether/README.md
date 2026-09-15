# Nether combat expeditions

These scenarios test the complete encounter on generated Nether terrain:
approach, fight, collect, recover, and return. Focused flat-world regressions
remain useful for isolating individual mechanics.

For explicit lava-edge, bridge, and cliff pressure, see
[combat beside hazards](../../COMBAT_TERRAIN.md). An ordinary uneven-ground
expedition does not qualify those cases by itself.

Run this suite from the repository root:

```sh
npm run scenarios -- scenarios/default/nether --repeat 1 --jobs 2
```

The command uses two disposable servers concurrently to limit the additional
Java processes while a playtest server may also be running. Mine Labs owns
server arrangement, independent goals, reports, and cleanup. Scenario drivers
use the production Mine AI MCP runtime and its ordinary action contracts.

## Arrangement

The initial locations are surveyed in Minecraft 1.21.4 on seed `20260906`.
These fixtures explicitly enable `world.structures` so the generated fortress
exists. Mine Labs also evaluates the return coordinates in the named player's
current dimension. The installed Mine Labs version must support both behaviors
before this suite runs.
Coordinates must identify observed standing positions, cover, and available
routes. Preserve the generated terrain; a seed alone does not establish that a
chosen coordinate is a usable arena or an escape route.

The scenario file declares the arrangement: `world.dimension: the_nether`,
each player's surveyed `pos` and starting `health`, and the native mobs as
`entities`, summoned with `NoAI` after the client is prepared and released by
the driver as its first act. Mine Labs pins, builds, snapshots and restores
the arena in that dimension. A driver equips armour and checks that the
survey still holds; it never teleports, heals or summons on its own before
`start`. During the measured attempt, no teleport,
healing, forced kill, changed loot, frozen mob, or equipment grant may rescue
the bot. Initial controlled mob placement makes failures easier to reproduce;
it does not establish reliability against unrestricted natural spawning.

Use normal difficulty and the expedition kit, including iron armor with gold
boots, sword, shield, bow, arrows, food, and building blocks. Any deliberate
variation belongs in the scenario description and result. A retreat fixture
must establish that an exit exists before judging the combat response.

## Verdicts

- A hunt expedition succeeds only when the requested inventory gain is observed
  and the bot returns alive with those items. A kill without a native drop is
  recorded separately and cannot count as a completed expedition.
- Withdrawal succeeds through observed survival and escape or effective cover.
  Killing every enemy is not required. Returning a cancellation or releasing
  controls alone does not establish safety.
- Death at any time fails the attempt, including death followed by respawn.
  Initial presence at the return point cannot satisfy the final return check.
- Retain the action outcome and actual dimension, minimum and final health,
  deaths, kills, gained objective items, ammunition use, elapsed time, and
  encounter interruptions where available. Separate missing observations from
  zero values.

Repeat the qualified cases to expose timing and native loot variation. Report
attempt counts and outcomes, including failures; one successful demonstration
does not establish an expedition success rate. Reduce concrete failures to a
focused regression at the layer that owns them before broadening difficulty.

## Qualification

The warped-forest standing cells are observed in that biome at their actual
heights. The lower route starts at `98,59,8`; the upper route at `100,64,18`.
The fortress anchor is near `-432,272`, with a lower bridge at feet Y60 and an
upper room at Y66. Route-only controls established the approaches and exits
before combat qualification.

| Case                                             | Measured condition                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [Nylium approach](enderman-nylium-approach.yaml) | Hunt among three native endermen, collect a pearl, and return across uneven ground.                                      |
| [Uphill return](enderman-slope-return.yaml)      | Hunt below a higher refuge and return after native teleport pursuit.                                                     |
| [Fortress sortie](fortress-sortie.yaml)          | Hunt two blazes with a wither skeleton present, collect a rod, and return from the raised room.                          |
| [Wounded withdrawal](fortress-withdrawal.yaml)   | Escape blaze and wither-skeleton pressure at eleven health, without regeneration, then remain alive at the western exit. |

Both enderman approaches disable digging and scaffolding on the short,
independently qualified outbound leg. Returns use ordinary navigation policy,
including carried building blocks. The fortress returns also use that policy.
All four cases retain the runtime for 100 ticks after returning, so delayed
damage or contact can invalidate the result. That five-second observation is
not a claim of indefinite camp safety.

Three fortress sorties and three wounded withdrawals passed the initial batch.
Each sortie returned with a native rod; all ended at twenty health. Two took no
damage, and one recorded 7.16 health lost across regeneration. All withdrawals
remained at eleven health, took no damage, and observed safe separation. No bot
died in these six attempts. Native mob placement is controlled; unrestricted
natural spawning and a continuous spawner siege remain outside this batch.

The first enderman batch exposed a fixture error: armor clicks performed in
spectator mode did not equip the server-side inventory. Its five successful
returns and one death are retained as an unarmored baseline, not qualification
of the intended kit. Arrangement now equips in Survival and requires a native
server query to confirm all four armor slots before summoning mobs.

The death recording also exposed sword collateral damage while a nearby
enderman moved across the old feet-distance guard. The production guard now
uses the observed body bounds, and the focused
[bystander regression](../../flat/hunt/enderman-bystander.yaml) preserves that
case. The old built controller damaged both native mobs in the focused test;
the corrected build selected the pickaxe and left the moving bystander at full
health.

The corrected armored batch passed all six attempts, three per enderman route.
Each returned with a native pearl, with no bot deaths or arrows consumed. All
finished at twenty health; the lowest observed health was 15.94. One return
recovered from a second encounter, and one climbed from Y40 back to Y64 using
carried blocks. These are six observed successes on the declared arrangements,
not an estimate of unrestricted Nether expedition reliability.
