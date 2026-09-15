# Combat beside hazards

These scenarios qualify combat and navigation together where a misplaced step
can become a fall or lava contact. Ordinary uneven-ground expeditions do not
establish this behavior.

Run the focused suite from the repository root:

```sh
npm run scenarios -- scenarios/flat/combat-terrain scenarios/default/nether/hazards --repeat 1 --jobs 2
```

Two concurrent disposable servers keep the additional Java process count small
while the persistent play world may be running. Setup may grant equipment and
place native mobs. After the measured encounter starts, the driver must not
teleport, heal, freeze, or rescue either participant.

## What constitutes evidence

A successful route without an attack is not a combat qualification. Each case
must establish its declared pressure from native observations, such as a shield
block, attributed damage, pursuit, or a target moving across the hazard. Record
where the bot was when that happened. A shielded attack proves defensive
handling; it does not prove recovery from knockback that never occurred.

Observe the whole attempt for death, lava contact, and falls beyond the declared
standing surface. Require an actual recovery destination or resolved encounter,
then retain the active runtime for delayed damage. A respawn at full health or
a cancellation alone cannot satisfy survival. Keep failed and unexercised
attempts alongside successes, and distinguish arrangement repairs from changes
to production behavior.

Use generated terrain where the surveyed location provides the intended hazard.
Use a constructed fixture when exact geometry is necessary to isolate a failure;
describe it as constructed. A seed or a bridge-shaped floor does not by itself
prove exposure to a dangerous edge.

## Qualification

| Case                                                       | Terrain and required pressure                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Lava shore](flat/combat-terrain/lava-shore.yaml)          | Constructed level lava shore; two native zombies attack from different angles. A hit or shield block must occur on the last dry row. |
| [Side bridge](flat/combat-terrain/side-bridge.yaml)        | Constructed two-block-wide bridge above lava; a native skeleton shoots from a side platform. Contact must occur on the span.         |
| [Wounded cliff](default/nether/hazards/wounded-cliff.yaml) | Generated Nether cliff; native angry pursuit begins at the lip, followed by real separation or independently verified closed cover.  |
| [Canopy gap](default/nether/hazards/canopy-gap-hunt.yaml)  | Generated Nether canopy gap; select and engage the opposite-side enderman, then recover native loot without an unsafe fall.          |

The first fixed shore/bridge batch ran three attempts per case. All six survived
and reached their destinations without descending below the deck or entering
lava. Two attempts per case also observed native damage and knockback at the
hazard, satisfying the pressure verdict. The remaining shore attempt took its
hits after reaching safer ground; the remaining bridge attempt blocked an arrow
on the wider side platform. Both correctly remained unexercised for the declared
hazard pressure. No-contact runs must not be presented as successful knockback
qualification or as production safety failures.

These fixtures retain positions, body support, health, native damage sources,
shield blocks, and velocity packets around contact. The lava check distinguishes
the native fluid flag from conservative full-body overlap with a lava cell.
Horizontal overhang with remaining dry support is observable and may recover;
falling into the source cell fails the verdict.

The generated cliff case exposed a real failure. With eleven health,
the bot began evacuation from observed angry enderman pursuit, took a native
hit during a planned three-block drop, missed the landing and died after falling
eleven blocks. The route was physically valid without the attacker. A calibration
using the installed physics and captured terrain reproduced the fatal coast;
three direct air-steering alternatives still missed the intended landing.

A diagnostic evacuation policy limiting drops to one block avoided that large
fall in its trial, but the enderman killed the bot through repeated melee hits.
That change was reverted. The existing shelter primitive then built a complete
enclosure at the same starting position and held eleven health with the native
angry enderman adjacent.

The production response now prefers existing shelter when a wounded bot faces
an enderman in contact. Healthy fights, other wounded encounters, prior creeper
and unreachable-target priorities, and the guard against repeating a failed hide
are preserved. No new movement controller or drop restriction is introduced.
The cliff verdict accepts actual separation or a complete nine-cell enclosure
with solid support and clear body space through 100 grounded, idle, living ticks.
Initial angry pursuit at the cliff remains required; continuing aggression after
successful concealment is recorded but is not required for success.

The integrated response passed three unchanged native cliff trials. All three
selected shelter through the normal runtime, completed the nine-cell enclosure,
and held eleven health without a fall or lava contact. Each final observation
recorded 100 covered ticks with the angry enderman still nearby (1.80, 1.58, and
1.13 blocks away at completion). This qualifies shelter at the surveyed start;
it does not establish recovery from arbitrary airborne knockback or a safe exit
from cover while the attacker remains outside.

An earlier experiment survived its initial evacuation but died after the driver
sent it back toward the encounter. Its results and reconstructed driver remain
separate from the one-evacuation regression. A successful evacuation does not
qualify a subsequent return toward the still-angry target.

The canopy gap passed three native trials on the original production policy.
Each latched the hunt with the bot and its selected enderman on opposite sides,
observed native attacks and the exact target's death, and returned with one
pearl. All finished at twenty health, without death or lava contact. The
lowest observed Y values were 54, 40, and 54; every individual unsupported
descent remained within three blocks. Returns used three, five, and three
carried scaffold blocks. These are successful pursuit-and-return trips across
generated terrain, not proof that every enderman teleport or loot drop is safe.
