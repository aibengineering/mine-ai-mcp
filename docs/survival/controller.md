# The combat controller

The controller owns physical combat until its effects and movement release have
settled. Its callers retain the requested objective and interpret the outcome.

[`control/controller.ts`](../../src/survival/control/combat/controller.ts) admits one
operation and reconciles policy changes. [`control/engagement.ts`](../../src/survival/control/combat/engagement.ts)
dispatches the selected response while retaining the quarry.
[`responses/fight/run.ts`](../../src/survival/responses/fight/run.ts) composes scene
observation, weapons, locomotion, cover and Enderman mechanics. Changing a tactic
does not require editing admission or request lifetime code.

```typescript
engage(
  targetId: number,
  signal: AbortSignal,
  movement: "pursue" | "hold",
): Promise<CombatOutcome>
```

`pursue` permits an approach subject to combat policy. `hold` permits immediate
defence from the caller's position. The hostile observer and deliberate hunt use
the same controller. The pure decision receives their request purpose separately;
automatic pursuit permission does not cancel an explicitly requested quarry.

## Targets, equipment and attacks

Automatic target utility considers contact, reach, exposure, confirmed attacks,
drop ground and distance. The controller can guard or strike another authorized
attacker while preserving the requested target's identity and death verdict.
Defensive hits are counted separately and cannot renew quarry progress.

[`equipment.ts`](../../src/survival/weapons/equipment.ts) selects equipment without changing
it; equipping is a separate awaited effect. It prefers swords, axes, pickaxes,
shovels and hoes, selecting material within each family. An empty hand remains a
melee fallback. Policy filters the permitted items, and
[`melee.ts`](../../src/survival/weapons/melee.ts) excludes a sword when its sweep would hit a
player or neutral bystander. The final swing checks collateral risk again after
aiming and readiness.

Current equipment is selected from the actual body position, including arrivals
slightly off a planned centre. A shooter entering sword reach cannot leave the
bow selected merely because the original plan priced a ranged stance.

| Mechanic                  | Contract                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Melee reach               | At most three blocks from the observed eye to the target body, with an unobstructed body ray.                  |
| Cooldown                  | Hand 5 ticks; sword 13; pickaxe 17; shovel/hoe 20; axe 25. Equipment changes invalidate readiness.             |
| Open-ground bow selection | Prefer the carried bow with arrows beyond six blocks or against a target more than three blocks above the bot. |
| Protected firing position | May choose a usable bow inside the ordinary open-ground distance cutoff.                                       |
| Bow draw                  | Twenty ticks, with trajectory and interruption checks while drawing and before release.                        |
| Shield                    | Requires actual item use and readiness; a requested raised posture alone is insufficient.                      |

Bow trajectory checks use compensated flight and terrain collision. Cancelling a
draw changes the active slot to prevent releasing an unintended arrow. Shield
facing accounts for visible windups and incoming projectiles. A terrain-hidden
charge cannot repeatedly cancel a dig, while a projectile already in flight still
requires defence.

A newly observed inactive-to-active blaze charge provides its sixty-tick first-shot
window. An unshielded bow can use the early portion while retaining a full bow-draw
duration before the volley is due. A first-observed active flag has unknown age;
hidden time and melee contact do not restart the window. Actual projectiles still
require a return regardless of that estimate.

## Position and movement ownership

Immediate tactics use a shared [pure decision](../../src/survival/policy/combat/tactics.ts).
The [tactical controller](../../src/survival/control/combat/tactics.ts) assembles
surrounding creepers, retained clearance, projectile impact/coverage, current
equipment, retreat geometry and permissions. It observes every physics tick,
including during a bow draw, guard, cooldown, approach or construction effect.
An active blast, or a creeper closing during bow use, takes priority over projectile
guarding. This is a conservative severity decision, not an exact damage simulator.
An aligned shield can still accompany an approach between incoming projectiles.

Creepers use the same attack loop, body reach, contact defence, shield and cover
handling as other quarry. A melee hit supplies sprint knockback without walking
forward, then records a clearance obligation for the next shared decision. The
execution layer does not independently retreat because it counts two nearby
creepers. Observed cover and fuse unwind release the emergency for every target.
A terrain-hidden quarry cannot suppress a reachable attacker, and a possible
contact swing is not priced as a stationary bow commitment.

The controller aborts the current effect's signal and awaits its cleanup before
the next tactic uses the body. It retains the engagement and requested quarry.
Critical footing recovery remains first and can keep a shield facing the blast.
Escape requires observed clearance along the player's full width. When escape is
blocked, the same decision can counter-hit a reachable creeper, place a supported
blast barrier with permitted carried materials, or brace while those options
change. This applies to mixed packs as well as a single creeper. Prohibited
retreat still permits authorized defence; a policy limitation is returned when
no permitted answer remains.

A blocked or expired blast retreat returns to this decision. It does not mark
the requested quarry unreachable. Failed barrier placement is remembered against
the cell, neighbouring blocks, occupancy, materials and permissions; merely
changing quarry cannot retry unchanged geometry. Short defensive effects finish
before another blast tactic starts. Unsafe knockback can interrupt them for
landing recovery. Target death does not discharge another creeper's clearance
obligation.

Fuse timing belongs to the connection's perception, so changing target or fight
owner cannot reset it. A first-seen active fuse is treated as due; an observed
unwind restores time gradually. With a shield available, a blocked defender
preserves its readiness during the last seven estimated ticks instead of
restarting the five-tick shield activation with another swing, placement or sprint.
The automatic contact wrapper also retains its owner while blast clearance is
pending, even when the original melee attacker has left reach.

The creeper responsible for that escape becomes the immediate defensive focus.
After separation it can be shot or knocked back instead of repeatedly retreating
while attacking a distant shooter. Focus changes update the selected target and
positioning together; its death restores the original quarry and cannot
report that quarry as defeated.

[Creeper clearance](../../src/survival/perception/combat/creepers.ts) belongs to the
connection's perception. It requires thirty observed physics ticks beyond eight
blocks or behind observed cover with the fuse no longer active, or confirmed
death. A matching native explosion followed by removal also discharges that
creeper's fuse; unrelated creepers remain pending. Missing entities otherwise
retain their last position. Covered, inactive creepers are not rearmed solely
because another fuse is still pending. Dimension changes and respawn discard the
old encounter's obligation. The retreat executor reports expiry and interruption
separately from observed clearance.

Evasion uses the same clearance policy when admitting or releasing a stationary
projectile guard. A closing creeper interrupts shield readiness and returns the
body to the escape route; fresh arrows cannot keep readmitting that guard while
clearance is pending. Evasion receipts retain explosions observed during escape.

[`CombatExecution`](../../src/survival/control/combat/execution.ts) names logical phases and
awaits complete physical effects. Repeated hold ticks preserve phase duration;
nested effects restore the surrounding phase. Navigation never restarts merely
because another physics tick arrives.

A guarded approach walks to preserve shield use. Contact, a relevant volley,
another attacker or an external impulse can return control from navigation to
combat. Approach goals use actual melee or bow feasibility; a request for safer
melee footing cannot settle on a bow-only arrival. The search detour radius is
32 blocks. Navigation reports search limits and the observed frontier separately
from exhausted reachable terrain.

Approaches do not excavate or scaffold while already in contact. They do not
pillar after a hovering shooter or follow one down a large drop. A shielded
shooter already in melee contact is defended immediately while footing recovery
continues to handle actual impulses. Ordinary terrain navigation retains its own
movement contract.

Fighting passages preserve a protected cell, corner, entrance and fighting cell.
The current geometry decides attack, return, hold or replacement. The same refuge
retains its policy-selected damage-progress budget (300 ticks by default) through temporary exposure, plan
replacement and recovery. Confirmed damage to the requested quarry renews that
window; incidental attacks and route steps do not.

Cover movement, roof/backstop construction and their searches release navigation
when the shared footing observer detects unsafe knockback. The same engagement
then owns landing recovery. This suspension does not blacklist the interrupted
geometry or create a second controller for the airborne body.

If knockback passes below the original floor, recovery can steer toward an
observed lower terrace within three blocks of the original support,
including a nearby supported centre when free flight overlaps a broken
edge. Predicted support only selects the landing; actual ground and a safe
coast corridor are still required before the pending request resumes. Shield
protection can continue while landing, including in the standalone footing reflex.
An involuntary high arc can still cause fall damage; recovery keeps answering
the landing instead of treating that possibility as a reason to give up. Combat
retains its shield through an internal landing; a standalone landing owner
releases its item use before handing back to navigation.

## Special physical mechanics

- Phantoms and vexes are met from supported ground when they dive. Leaving the
  16-block holding range ends an unanswered hold.
- Creeper mechanics observe concurrent fuses, use supported retreat clearance and
  release shield slowdown before sprinting. Cornered defence uses the shared
  tactical decision and observed geometry; it does not assume a retreat route exists.
- Enderman pursuit prices a roof before provocation. Existing protection can
  permit a deliberate melee provocation even when the roof occludes the eyes.
  A selected quarry's observed aggression may settle its own lure; this does not
  authorize automatic attacks on unrelated angry Endermen. Roof construction
  yields when an attacker reaches the unprotected body. Failed preparation is
  scoped to its site, and roof progress renews only on confirmed quarry damage.
  Nearby existing ceilings and solid two-high alcoves are reusable; existing
  masonry can also support completion of a partial roof. A stalled quarry permits
  a checked level walk toward and beyond the eave, up to four cells. Observed
  quarry movement triggers the return along saved waypoints; an interruption
  preserves that return. Neutral provocation instead waits for observed hostility.
  Shield availability is optional, and lure movement never renews the damage budget.
  Lure and return ticks may take a ready shared melee strike without stopping for
  its cooldown. These sword hits retain the guard; reach, bystanders and weapon
  readiness use the same checks as ordinary combat.
- End crystals and dragon perches use request-lifetime observation objects bound
  to entity identity and dimension. Crystal destruction can complete during
  suspension, and a released arrow's observation window uses server time.
- End escape uses supported passages and disables new aerial scaffolding during
  dragon contact. Crystal approach retains its separate construction capability.

Recovery retains the combat owner when current cover is usable. Otherwise the
shared recovery decision can select an enclosure or withdrawal. Food, current
health and policy determine eligibility; the required health is
`max(recover_to_health, engage_min_health)` for hostile pursuit. The pure
[`fight boundary decision`](../../src/survival/policy/combat/fight-boundary.ts) admits recovery
inside an already owned refuge. One hold (90 seconds by default) cannot be renewed by eating or
healing. An exhausted recovery returns its reason without erasing the enclosure.
Each bite releases any shield use that intruder defence raised during that hold.

## Settlement

| Outcome              | Observed meaning                                                           |
| -------------------- | -------------------------------------------------------------------------- |
| `died`               | The requested target's death was observed.                                 |
| `target_lost`        | It disappeared or became invalid without an observed death.                |
| `bot_died`           | The bot died during execution.                                             |
| `unreachable`        | An approach, position or progress window ended with a concrete limitation. |
| `capability_blocked` | Policy, materials, ranged equipment or recovery prevented continuation.    |
| `defence_required`   | A different immediate hazard must own the body.                            |
| `cancelled`          | The owning signal ended the effect.                                        |
| `failed`             | An execution or cleanup error occurred.                                    |

Every outcome retains attack, equipment, guard and explosion evidence.
An explosion alone does not veto request resumption after a completed response.
The resumed request rechecks the current destination/quantity, terrain and threats;
death, an unfinished response or a concrete capability limit still stops it.
Explosion observation spans the whole mob engagement, including a temporary
deflection or recovery response; its listener is released when that engagement
settles. Physical fight results still retain their own phase evidence.
[`CombatItemUse.neutralise`](../../src/survival/weapons/item-use.ts) finishes item
release and the applicable supported-body obligation before clearing locomotion.
Typed cancellation and an admitted footing transfer can end that old obligation;
the next owner still waits for authority. Unexpected cleanup failure is reported.

[`settlement.ts`](../../src/survival/control/combat/settlement.ts) consumes response-specific
results and maps `died` to `target_died` only when formatting the receipt.
Fight, deflection, withdrawal and enclosure keep their physical discriminants;
enclosure recovery is required evidence rather than an optional hint. Cancellation
and death retain physical results already returned by an executor.
An automatic target being lost
or unreachable does not itself terminate a resumable collection request; the
request reobserves current quarry and inventory after the response settles.


Enderman protection and productive fighting positions are separate admissions.
A replacement roof must offer an exposed sword strike or a checked, reversible
level bait path to one. A known enclosed shelter or a large quarry elevation
mismatch can trigger relocation before the confirmed-damage budget expires;
a temporarily distant quarry retains its normal return window. Rejected roof
positions remain scoped to the target's observed position. Repositioning uses
the configured terrain permissions and ordinary safe drops, with contact and
footing observations interrupting navigation before combat resumes.

Scaffold searches refuse cells occupied by other live mobs or players, and the
executor checks occupancy again after positioning and aiming. An individual
uncollected hunt drop does not terminate the quantity objective: the kill is
settled, the drop remains observed, and other quarry can be pursued. Inventory
exhaustion and cancellation retain their existing stop semantics.
