# Survival policy

The survival policy is the model's one way to shape what the bot does on its
own. Every reflex reads its rules from here, grouped by the domain each rule
governs: `navigation` for route caution, `combat` for automatic engagement, the physical capabilities, health
decisions and tactical thresholds combat may use, and `food` for automatic
eating. New reflex knobs join an existing group or add one; nothing tunable
lives anywhere else. `navigate` has no separate combat-mode flag: to travel
with limited automatic pursuit, the model sets `combat.engagement` to
`defend_only` with the lifetime it wants, then requests navigation.

## Model control

`set_survival_policy` has three operations, and every one carries the current
`expected_revision` and a `reason` in the model's own words:

- `set` merges the named fields as overrides. Each field becomes its own
  override with the lifetime given in that call, so setting `combat.hide` for
  an encounter leaves a `food.raw.allow` set for the session exactly where it
  was. Setting a field again replaces only that field's value and lifetime.
- `clear` removes overrides by path, such as `combat.hide` or `food.raw.allow`;
  those fields return to their defaults.
- `reset` removes every override.

Lifetimes are the connection `session`, a named active `encounter`, `until` a
declared health or carried-item condition holds, or `for` a fixed duration of
at most an hour. Each override expires on its own: an encounter override goes
when the encounter ends, a condition override when the condition is first
observed, a timed override when its time runs out. Death and dimension change
reset the whole policy through the same settlement mechanism.

The policy state commits the new revision, exposes its settlement barrier, notifies
consumers and waits for affected execution to release before the edit returns.
Relevant permissions are checked at physical boundaries, including nested recovery
and final handoff. A policy cancellation is not remembered as a failed capability.

Every action reply carries the policy: defaults, the effective policy, and each
live override with its path, value, lifetime, reason and expiry, so the model
can always see what it has changed and why.

## Navigation group

| Field | Default | Meaning |
| --- | --- | --- |
| `navigation.scaffold_blocks` | `["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "basalt", "end_stone"]` | Registered block item names automatic navigation and survival responses may place, in preference order. At most 16 names; `[]` disables automatic scaffolding. |
| `navigation.hostile_avoidance_multiplier` | `1` | Finite, nonnegative multiplier on the capped hostile proximity route cost. `2` doubles it, `0.5` halves it, and `0` removes proximity cost. |
| `navigation.bucket_fall_save` | `true` | Save damaging falls using carried water on loaded safe full-block floors, then verify source removal and a refilled bucket. |
| `navigation.bucket_drops` | `true` | Allow planned water-bucket descents up to 80 blocks. Independent of scaffolding and emergency fall rescue; unavailable in the Nether. |

The scaffold list is read from the live policy whenever a consumer chooses a
block. The first usable carried name wins over stack size; unsafe entries are
skipped. Scoped expiry, `clear`, and `reset` restore the default in the same
way as scalar fields.

Species retain their built-in relative penalties and avoidance radii. A species
whose arrival decides the fight - a creeper, a piglin brute, a wither skeleton -
is priced from beyond the range at which it picks the bot up, so the route bends
before the mob is the one choosing. A species worth walking away from is priced
from the contact boundary instead.

Proximity costs sum across hostiles and are then capped. The cap rises with the
number of *severe* hostiles reaching a cell - those that win the fight on
arrival - so a group prices above the dearest one of them, up to a bounded
number of them; ranged hostiles never raise it, since proximity cannot tell
whether they have a sight line. The multiplier applies **after** summing and
capping, so the cap does not swallow an increase. Higher values make longer detours more worthwhile;
they do not prohibit a route or change which entities count as threats.
The critical-health line-of-sight exposure penalty stays separate and unscaled.

Ordinary navigation and evade routes use this setting. Deliberate combat
approach, cover and hunting routes that opt out of the hostile field remain
exempt. Engagement decisions and `combat.evade_safe_range` are independent.
There is no special water multiplier.

Each route search snapshots the current value; edits and expiry affect the
next search, without forcing an already planned route to stop or replan.
The multiplier is part of the field fingerprint so a changed cost is a new
search question. The usual policy lifetimes, clear and reset operations apply.

For example, use `set_survival_policy` with the current revision:

```json
{
  "operation": "set",
  "expected_revision": "<current survivalPolicy.revision>",
  "changes": { "navigation": { "hostile_avoidance_multiplier": 2 } },
  "lifetime": { "kind": "for", "duration_ms": 120000 },
  "reason": "Take wider detours around threats during this journey"
}
```

## Combat group

| Field                                       | Default                  | Meaning                                                                                                                           |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `combat.engagement`                         | `respond_to_threats`     | Automatic pursuit preference; `defend_only` keeps immediate defence and permitted retreat.                                        |
| `combat.hide`                               | `when_recovery_possible` | Allows automatic enclosure when recovery is available. `when_exposed` also permits emergency cover without healing prerequisites. |
| `combat.recover`                            | `when_possible`          | Allows recovery inside an independently permitted response.                                                                       |
| `combat.retreat`                            | `true`                   | Allows combat-owned separation movement.                                                                                          |
| `combat.melee`, `combat.bow`, `combat.shield` | `true`                 | Permitted attack and guard capabilities.                                                                                          |
| `combat.terrain.dig`, `combat.terrain.place` | `true`                  | Combat-owned excavation and construction.                                                                                         |
| `combat.engage_min_health`                  | `12`                     | Minimum health for pursuing a hostile; immediate contact defence is separate.                                                     |
| `combat.critical_health`                    | `8`                      | Below this health, observed nearby threats can trigger protection before contact; a stationary retreat guard stops below it.      |
| `combat.recover_to_health`                  | `18`                     | Recovery target; hostile pursuit uses at least `engage_min_health`.                                                               |
| `combat.protected_wait_ticks`               | `300`                    | Protected waiting without confirmed quarry damage before rejecting the position.                                                  |
| `combat.enderman_wait_ticks`                | `300`                    | Enderman lure or roof waiting window; commands and incidental damage do not renew it.                                             |
| `combat.volley_wait_ticks`                  | `100`                    | Window for an observed ranged volley to finish.                                                                                   |
| `combat.recovery_timeout_ms`                | `90000`                  | One protected recovery hold, including movement and eating.                                                                       |
| `combat.evade_timeout_ms`                   | `15000`                  | One withdrawal attempt, including replacement routes and projectile guards.                                                       |
| `combat.evade_safe_range`                   | `36`                     | Required observed separation from every threat.                                                                                   |

Health values are Minecraft health points (0–20), tick and duration limits are
positive integers, and separation is a positive block distance. Raising pursuit
health above the recovery target raises the effective recovery requirement with it.

Explicit resource quarry remains authorized under `defend_only`. Combat still
honors its weapon and terrain permissions. Ordinary navigation's own digging and
scaffolding arguments remain separate.

`combat.shield` also gates admission rather than only tactics: with it false, a
`collect_mob_drop` request for hostile quarry is refused with `HUNT_NO_SHIELD`
even when a shield is carried, because the fight would be unshielded either way.
That request's own `allow_without_shield` overrides the refusal without changing
the policy.

## Food group

| Field                       | Default          | Meaning                                                                                                                                     |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `food.raw.allow`            | `emergency_only` | When automatic eating may spend uncooked food (beef, porkchop, mutton, rabbit, cod, salmon, potato). `always` and `never` bypass the floors. |
| `food.raw.hunger_at_most`   | `6`              | Under `emergency_only`, uncooked food is eaten once hunger is at or below this; sprinting stops at six.                                     |
| `food.raw.health_below`     | `10`             | Under `emergency_only`, uncooked food is also eaten to heal while health is below this and hunger is under the regeneration bar of 18.      |

The `food.raw` rule applies to every automatic eater: the hunger reflex,
covered recovery, and the End perch. It exists because a hunt that eats its
own drops raw never has anything to cook, and raw meat is worth more than
twice as much cooked. Outside an emergency the reflex stands down with the
floor it is waiting for as its stated premise, and a recovery hold ends at
once naming the withheld meat. An explicit `eat_food` request is never
affected; the model chose that meal itself. Raw chicken stays off the
automatic menu regardless because of its hunger effect.

Revoking a meal's permission stops its active bite and waits for physical
release before the policy edit reports settled. Combat recovery owners also
reconcile food-rule changes. An unrelated combat edit leaves an ordinary
hunger-reflex meal running. Historical `combat_policy` events remain readable
alongside new `survival_policy` events without changing the stored history.

See the [policy contract](../../src/survival/policy/contract.ts) and
[policy state](../../src/survival/state/survival-policy.ts).

## Attribution and contact

[`hostileRelationship`](../../src/survival/perception/combat/threats.ts) owns distinct `avoid`
and `defend` facts. Hostile game metadata is not by itself sufficient for neutral
species. Confirmed bot-directed damage and owned incoming projectiles establish
attacker history; observed deaths exclude lingering dying entities.

- Enderman anger alone does not identify the victim. Bot-directed damage or an
  angry head gaze intersecting the bot can authorize defence. A later observed
  attack on another victim retires old attribution.
- An aggressive piglin with no observed victim can require avoidance while
  remaining unauthorized for attack. Zombified piglins likewise require provocation
  evidence before defence.
- Daylight and local skylight can make a spider passive. Players, passive mobs,
  armor stands and neutral bystanders remain protected from incidental sweeps.

Contact ordinarily requires current exposure and either eight-block proximity or
recorded attack history. Nearby threats are gathered within sixteen blocks;
confirmed attackers can remain relevant beyond that passive observation radius.
An exposed bow holder drawing while its head points toward the bot also counts
as contact, at any loaded distance. This uses the same body-intersection and
packet-angle tolerance as Enderman attention. Drawing toward someone else does
not extend contact range, and this cue does not override neutral-mob permissions.
During a guarded combat approach, predicted incoming arrows and blaze fireballs
yield navigation's heading to projectile-facing defence. The same detector keeps
the volley guard active while a threatening shot remains in flight.
Defensive facing is independent of the selected attack target. The shared
assessment prioritises predicted impacts, includes exposed aimed bow draws, and
reports whether one shield cone can cover the observed directions. Opposed
shooters use the best available heading without repeatedly demanding impossible
coverage. Position effects also yield on incoming projectiles and finish their
cleanup before guard takes control. Guard decisions record stop, admission and
local facing boundaries; a local facing update is not a server acknowledgement.
Covered recovery and candidate protection checks reject incoming arrows as well
as fireballs. These checks do not establish that every recovery withdrawal or
crossfire pattern is damage-free; native skeleton qualification still fails.
Optional fighting cover is priced before construction. Missing building material
excludes that cover choice, rather than ending the fight; ordinary guarded combat
and health-based responses remain available. Existing terrain cover can still be
used without carrying blocks.
Ordinary melee mobs must enter defensive reach to interrupt a healthy journey.
Their airborne descent remains contact while it threatens the standing body.

## One decision with an explicit purpose

[`decideCombatResponse`](../../src/survival/policy/combat/decision.ts) consumes a single
observation containing health, burning, recovery eligibility, equipment, policy,
contact relationships, target utility, incoming fireball and retained answers.
It performs no world reads or control writes.

Automatic response can deflect a fireball, defend contact, fight, hide or evade.
Low health, concurrent creepers, missing capabilities, prohibited responses and
previously answered attempts constrain that choice. `defend_only` can still permit
a close defensive swing; it does not start a new pursuit.

An admitted `collect_mob_drop` declares its species as quarry for the life of
the request. Automatic contact with a hunted species is fought, never withdrawn
from, while health permits fighting at all: the critical-health and
engagement-minimum rules still hide or evade, and creeper contact keeps its own
rule. When the fight for a hunted contact is already answered or the contact is
marked unreachable, the reflex returns no directive and the hunt decides by its
own stop counts. A hunt that walked toward a skeleton while a reflex fled the
same skeleton took turns owning the body until the request timed out.

Every `[HOSTILE_CONTACT]` interruption names the response, each threat's cell
and distance at the decision, and, for evade, hide and deflect, the decision's
reason in parentheses, so a caller can tell a
withdrawal to accept from one to change with a policy edit or another request.

Requested pursuit names its authorized target and minimum health. Recovery asks
for permitted healing toward `max(recover_to_health, engage_min_health)`. Handoff asks for observed
protection or separation after the requested quantity is attained. Those purposes
must not be inferred from an action name or reduced to automatic contact rules.

By default, evade uses a single 15-second attempt across replacement routes and
projectile guards. It aims eight blocks beyond the configured separation to allow
for pursuing threats. Recovery defaults to a fixed 90-second hold. Repeated moves
or healing cannot renew those attempts. Relevant edits settle the current owner
and reobserve; they never silently extend an active budget.

## Transfer and request continuation

The shared [reflex driver](../../src/survival/control/driver.ts) requests admission
from [the runner](../../src/session/action-runner.ts). The runner reserves the
successor before aborting current execution, performs the admitted release hook,
and awaits cleanup before granting physical ownership. Higher-priority survival
responses use the same protocol.

An automatic target death, target loss, unreachable target, ended contact,
successful separation, reflected projectile or recovered shelter can resume the original resumable
request while the bot is alive and no explosion occurred. A stopped capability or
unhealed shelter returns its observed limitation. A one-shot transaction is never
replayed automatically. There is no arbitrary three-resumption cap.

Resumption reconciles the same request and its checkpoint. Inventory and destination
conditions are checked again at settlement; a reflex may have consumed material
or moved the bot. Expected portal transfer reconciles the destination dimension.
Death ends the old request, and connection loss settles callers without waiting
forever for disconnected physical work.

[`Answered`](../../src/survival/state/answered.ts) records a failed capability with its
actual settled facts and consumed permissions. Changed relevant facts can rearm it;
a timer, damage alone or an unrelated pickup cannot. Observation continues while
a capability is answered. Survival receipts identify excluded responses and the
retained answer or permission that excluded each one.
