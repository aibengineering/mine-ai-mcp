# Testing combat and survival control

The package tests establish contracts and state transitions. Mine Labs establishes
physical outcomes on fresh Minecraft 1.21.4 servers. Neither substitutes for the
other. Physical acceptance thresholds are declared in each scenario fixture.

## Contract checks

From the repository root, run `bun run test`. It runs the production typecheck, the
scenario-driver typecheck, and colocated tests.

Focused checks can use Bun from the package root:

```sh
bun test src/survival src/session src/navigation/steering src/actions/portal-entry/portal-entry.test.ts
```

Combat resource progress is tested with recorded event sequences in
`src/runtime/combat-resource-events.test.ts` and waiter-local accumulator tests
in `src/session/progress.test.ts`. These tests deliberately separate a release
command from its projectile/inventory confirmation and a shield block status
from an unrelated durability update.

The checks cover admitted body release, nested cancellation, request resumption,
death and disconnect settlement, policy revocation, Answered invalidation,
fixed budgets, shared decisions, current-condition completion, and durable End
effects. A stopped client physics stream must still permit cancellation; a
disconnected Mineflayer operation must not keep the protocol request pending.

## Physical groups

Run a named fixture or directory with the installed Mine Labs runner. For example,
from the package root:

```sh
bunx --bun mine-labs run scenarios/flat/combat --out .mine-labs/combat --repeat 1 --jobs 2 --isolated
```

Default to two workers total and run groups sequentially; overlapping runner
commands multiply the Java servers and can overload the host. Use distinct output
directories for each qualification. Set
`--keep-runs` to retain every declared repetition before starting a qualification
larger than the runner's retention default. Never restart a persistent live bot
to test this rewrite.

| Group                                                                                                                 | Physical contract                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Flat combat](../../scenarios/flat/combat)                                                                            | Idle contact, shield readiness, bows, packs, fuses, protection, body handoff, and pending request continuation       |
| [Hunt](../../scenarios/flat/hunt)                                                                                     | Requested quarry, moving bystanders, incidental kills, dropped items, capacity, and safe quantity handoff            |
| [Survival](../../scenarios/flat/survival)                                                                             | Fire, lava, air, hunger, shelter, and cancellation                                                                   |
| [Combat terrain](../../scenarios/flat/combat-terrain) and [generated hazards](../../scenarios/default/nether/hazards) | Supported attack positions, native knockback, slopes, lowered floors, gaps, and lava edges                           |
| [End](../../scenarios/default/end)                                                                                    | Crystal bow/melee/cage paths, dragon breath and body escape, safe gaze, one perch window, and mixed Enderman contact |
| [Portal](../../scenarios/flat/portal)                                                                                 | Portal activation and expected dimension transfer retain their own completion contract                               |
| [Evidence catalog](../../scenarios/flat/evidence/action-catalog.yaml)                                                 | Every published tool's real MCP schema, response, and survival status                                                |

Each YAML owns its seed, geometry, mobs, gamerules, kit, and independent goal.
Gameplay scenarios specify a problem and observable success, not a required
combat state or sequence of tactics. A safe detour, shield preparation or shelter
may be a valid solution. Use state and ownership traces to explain outcomes;
keep exact transitions and cleanup invariants in component tests.

Additional gameplay coverage includes `wounded-supply-return` (bring eight iron
ingots home alive from a wounded, hungry start with native enemies),
and `skeleton-bones-limited-ammo` (acquire three native bones with one starting
arrow). These do not require healing, changing weapons or hiding: any strategy
that meets the declared goal is valid. Mixed-creeper travel is covered by the
desert and cave navigation scenarios described below.

Focused damage tests may disable regeneration; recovery and collection tests
require native regeneration. Some fixtures freeze time; the full-night fixture
advances actual time to dawn. Do not describe these as one common arrangement.

The evidence catalog uses an in-memory MCP transport over a real Mineflayer
runtime. Its flat tour explicitly expects missing-target failures for crystal
and perch and a missing-eyes failure for stronghold. It verifies those exact
boundaries and labels them in the generated page. Successful End and stronghold
execution belongs to their dedicated physical scenarios. An unexpected error or
a missing survival summary fails the catalog.

## Whole-job acceptance

| Fixture                                                                            | Acceptance                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Fortress twelve rods](../../scenarios/default/nether/fortress-twelve-rods.yaml)   | One pending hunt; twelve native rods at at least one per minute; survival within 900 seconds; original generated spawner and ordinary loot |
| [Nylium pearls](../../scenarios/default/nether/enderman-six-pearls-rate.yaml)      | Three repetitions, each six native pearls at at least one per minute and an observed return home alive                                     |
| [Slope pearls](../../scenarios/default/nether/enderman-six-pearls-slope-rate.yaml) | The same three-repetition count, rate, and return requirement on generated slopes, within 480 seconds                                      |
| [Full End fight](../../scenarios/default/end/ender-dragon.yaml)                    | All crystals destroyed, native dragon death, and survival; report damage separately from navigation progress                               |
| [Full night](../../scenarios/flat/combat/full-night-request.yaml)                  | Reach dawn alive while preserving one pending request; one final handoff; no repeated successful shelter claims                            |

Declare repetitions and thresholds before running. Retain failed attempts and
timeouts alongside successes. A later successful run does not erase an earlier
failure or qualify an older source revision.

Whole-job drivers save `qualification-source.json` and a compressed complete
source snapshot in their artifacts. Reports must identify the source, outcome,
native quantity, elapsed time, throughput, health/deaths, and final handoff.
Changing an arrangement or gate creates a different qualification.

## Incident evidence

The mixed creeper regressions are `navigation-creeper-desert-crossfire` and
`navigation-creeper-cave-crossfire`. Native melee and ranged attackers engage
before a creeper closes. Their common driver issues one normal navigation request,
records selected target, response phase, fuse observations and explosions, and
requires the destination at a minimum of twelve health. It also verifies that
creeper and other-mob proximity overlapped, so a bypass cannot qualify mixed combat.
Neither driver retries the request or selects a tactic. Component retreat tests
remain useful but do not qualify these ownership and continuation transitions.

The wall-pressure regressions are `navigation-creeper-wall-pocket`,
`navigation-creeper-wounded-pocket`, and generated-terrain
`navigation-creeper-rocky-crossfire`. Each asks the bot to reach open ground alive
with iron equipment, a shield, food and building blocks available. The wounded
starts represent a journey already interrupted by fighting. Knockback, temporary
cover, digging, escape and other successful responses are all allowed; no goal
requires a particular attack, block placement, response state or explosion count.
`POCKET_STATE` telemetry records target changes, fuses, health, blasts and body
ownership to diagnose failures. A surviving blast followed by arrival passes.

Component tests separately verify that blocked retreat preserves the quarry,
counter-hits can address incidental creepers, barrier failures retain their site
premises, covered fuses unwind independently, and explosion/removal packet order
does not strand clearance. Footing tests require an observed landing before
continuation and exercise protection while falling to a lower terrace.

Read saved JSONL before attributing a death. Captures contain native damage and
velocity packets, controls, navigation, physics, combat phases, and survival
receipts. A death after a destroyed crystal is still a failed survival result.
An observed route step is movement progress, not confirmed target damage.

The recorder retains at most 20 seconds and 8 MiB per rolling capture. Its
directory retains five days and 64 MiB by default. Inspect `history.firstAtMs`,
`byteBudgetOmissions`, and recorder timings before claiming a complete window.
Copy relevant incidents into retained task evidence before rotation. Durable SQL
receipts can outlive their pruned detailed recordings.

The five receipt types are `survival_danger`, `survival_decision`,
`survival_claim`, `survival_phase`, and `survival_outcome`. They explain changing
decisions and owners; raw trace rows establish the intervening physical facts.
Standing down must identify the actual prohibited, missing, or previously
answered response. It must not be reported as safety.


Enderman shelter recovery is covered by `enderman-enclosed-shelter` and
`enderman-quarry-below-shelter`: defeat a native angry quarry from an enclosed
or elevated starting shelter, using the declared tools and supplies, and survive.
These contracts permit any successful combat strategy; they do not prescribe
roof states, transitions, or an exit direction. `pearl-occupied-scaffold` covers
collecting a raised drop while another Enderman occupies the direct construction
position. The generated Nether six-pearl expeditions remain the broader check
for target selection, repeated encounters, collection, survival and returning home.

`nether-vegetation-shelter` checks native wall construction through warped roots,
crimson roots and Nether sprouts. These are replaceable plants; recovery must
not reject an otherwise usable wall because the local plant list omitted them.

Water-bucket qualification uses `scenarios/flat/survival/bucket-fall-*.yaml` and `scenarios/flat/pathfinder/bucket-drop-route.yaml`. The fall drivers remove one supported platform after runtime admission and observe minimum health, actual airborne/grounded positions, source creation/removal, and bucket inventory. Impulse cases explicitly inject deterministic client velocity packets; the recorded End launch packet is not a native dragon replay. `scenarios/default/end/bucket-native-knockback.yaml` adds a real TNT blast in End geometry and requires survival, no native fall-damage packet, and recovered water. These fixtures do not claim that water prevents dragon magic damage or qualifies an entire dragon fight.
