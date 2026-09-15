# Survival control

Survival includes combat and environmental responses. An admitted request survives these responses taking turns
owning the bot. A collection request retains its inventory baseline and checkpoint
through defence, recovery and navigation. Success still requires its current
inventory quantity and an observed safe handoff. An observed crystal destruction
is instead a durable event that remains complete through interruption.

The [testing guide](testing.md) describes the contracts and physical acceptance
criteria used to qualify survival control.

## One survival module

The production home is [src/survival](../../src/survival). Its first level names
responsibilities. Combat-specific observation, policy, control and positioning
have subfolders inside those responsibilities; they share the response, state and
evidence homes with the environmental reflexes.

The reviewed design specifies ownership and dependency boundaries; it does not
prescribe these folder names. The `combat` subfolders are an implementation choice
for grouping target, weapon and hostile-specific code. Their parent folders name
the responsibility: `policy/combat` contains combat decisions,
`perception/combat` contains combat observations, and so on. They contain no second
reflex driver or body arbiter. All six automatic reflexes use the shared driver;
requested fights use the same policy, Answered and budgets under the request's
admitted owner.

Architecture implementation and whole-job qualification have separate completion
criteria. The ownership boundaries and focused regressions are implemented and
checked. Fortress collection/exit and successful request resumption through the
full low-health night remain unqualified, as recorded in the plan. The combat
subfolder names are not markers for pending migration.

```text
survival/
  control/             driver, registration and priority
    combat/            admitted operations, dispatch and settlement
      scopes/          response and recovery failure premises
  reflexes/            fire, breath, footing, dragon, hostile and hunger
  policy/
    environment.ts     environmental response decisions
    combat/            response, health, permissions and progress decisions
  perception/
    body.ts            air, burning and liquid contact
    combat/            threats, relationships, projectiles and End observations
  positioning/
    combat/            cover, exposure, construction and refuge movement
    fire-escape.ts     feasible fire exits
    swim-escape.ts     feasible surfacing exits
    footing.ts         projected landings
  responses/           fire, breath, footing, hide, recover, evade and deflect
    fight/             scene, weapons, movement and individual fight turns
    end/               crystal attacks, perch attacks and End escape
  weapons/             equipment, aim, item use, melee and projectile guards
  guards/              continuous Enderman gaze protection
  baseline/            idle buoyancy, released on admission
  state/               Answered, budgets, survival policy store and resources
  evidence/            composed status, receipts and formatting
```

The normal mob path is `control/combat/controller → engagement → selected response`.
[runMobFight](../../src/survival/responses/fight/run.ts) composes one physical fight
and releases its effects before another response starts. The fight scene asks
policy at health and position boundaries; tactics execute the selected decision.

[Observation assembly](../../src/survival/control/combat/observation.ts) combines
native facts, effective policy and retained answers. Policy receives values;
perception observes the world. Neither selects by importing a live executor or
mutable policy store. [SurvivalPolicyState](../../src/survival/state/survival-policy.ts)
owns editable overrides and settlement alongside the other state owners.
[Failure scopes](../../src/survival/control/combat/scopes) combine world and
inventory observations with the permissions an attempt consumed.

All six registrations live in [reflexes](../../src/survival/reflexes) and use one
driver. A registration supplies observation, decision, execution and settlement.
It never creates a second arbitration loop. Runtime-owned perception, footing
recovery and survival resources are required dependencies; responses borrow them
and runtime disposes them. Fixtures provide an explicit disposable owner too.

## Movement and lifecycle boundaries

| Home                                                                                   | Responsibility                                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [navigation](../../src/navigation)                                                     | Routes, movement generation, physical execution, local steering and supported holds.                                                    |
| [navigation/processes/portal-entry.ts](../../src/navigation/processes/portal-entry.ts) | The supported approach and final portal step through server-positioned arrival.                                                         |
| [survival](../../src/survival)                                                         | Combat, emergency movement and idle buoyancy under the session's body authority. Responses can borrow navigation's steering primitives. |
| [session](../../src/session)                                                           | Foreground request lifetime, admission, body preparation, reservation, transfer and cancellation.                                       |
| [runtime](../../src/runtime)                                                           | Bot attachment, resource composition, frontier and player-event lifetimes.                                                              |
| [diagnostics](../../src/diagnostics)                                                   | Incident observation, recording and capture.                                                                                            |

Actions own requested transactions and ask navigation or survival to move the
body. The two portal-entry actions own dimension intent, expedition supplies,
and the End respawn observation guard; navigation receives the selected portal and an abort signal. Session preparation
clears the old controls as part of admission. It does not run a movement loop.

[Enderman gaze protection](../../src/survival/guards/enderman-gaze.ts) constrains
requested looks and corrects an unsafe idle pitch while preserving movement yaw.
It has its own guard lifetime because it applies even without hostile admission.
Idle water stabilization is instead a baseline owner: runtime attaches it
separately from breathing and releases it before a response takes the body.

Footing recovery retains one support and impulse history across owners. Only its
admitted `recover` method steers or places a landing. The surfacing executor receives
its attempt budget from policy. Hunger remains observed while combat handles the
body, without admitting a second response. Regeneration hunger is a Minecraft
fact shared through [world/food.ts](../../src/world/food.ts). Whether uncooked
food is on the automatic menu is the policy's `raw_food` rule, decided in
[policy/food.ts](../../src/survival/policy/food.ts) from the bot's vitals and
applied by [perception/food.ts](../../src/survival/perception/food.ts) for every
automatic eater, so a hunt does not eat its own drops raw.

Dependency checks enforce pure policy, observation and response boundaries across
the entire survival tree. A movement boundary check prevents new direct control
writers in actions, runtime or unrelated modules.

## Ownership and decisions

[`ActionRunner`](../../src/session/action-runner.ts) owns admission, request
lifetime, body reservation and transfer. It reserves the successor before aborting
the previous execution, invokes any admitted release hook, and waits for physical
cleanup before allowing the successor to steer. Connection loss permanently closes
admission and settles callers even if a disconnected operation cannot finish.

[`ReflexDriver`](../../src/survival/control/driver.ts) owns the ranked fire, breath,
footing, dragon, hostile and hunger responses. Each response supplies observation,
decision, execution and settlement; it does not create another arbitration loop.
Idle water stabilization has a named baseline owner and yields on admission.

[`CombatPerception`](../../src/survival/perception/combat/observations.ts) shares packet and
visibility observations across readers. Relationship facts distinguish avoidance
from permission to defend. [`decideCombatResponse`](../../src/survival/policy/combat/decision.ts)
is pure and receives an explicit purpose: automatic response, requested pursuit,
recovery or handoff. An explicit quarry remains authorized under `defend_only`;
weapon, terrain and health permissions still apply.

The model changes permissions and thresholds through `set_survival_policy`. Its revision,
override, lifetime and settlement state appear in every reply. See the
[survival policy page](survival-policy.md) for attribution and continuation rules.

## Physical execution

The [controller](controller.md) awaits one physical effect at a time. Shared
primitives retain shield readiness, bow cancellation, melee collateral checks,
creeper fuse clearance, Enderman roofs, projectile defence and footing recovery.
Navigation owns routes; combat supplies the goal and movement permissions.

[`CombatPosition`](../../src/survival/positioning/combat/position.ts) owns fighting-cover geometry
and movement, while [`CombatItemUse`](../../src/survival/weapons/item-use.ts) owns held
item use. A planned position does not itself establish protection: current
collision shapes, threat exposure, incoming projectiles and the supported return
passage are checked again. Reachable fire in a passage can be extinguished within
the combat terrain permission.

Closed shelters and fighting cover share
[`recoverUnderCover`](../../src/survival/responses/recover.ts). Recovery requires
observed hunger, food or regeneration and targets
`max(recover_to_health, engage_min_health)` for hostile pursuit.
Loss of protection interrupts eating before defence resumes. Exhausted recovery
is retained independently of successful enclosure construction.

[`Answered`](../../src/survival/state/answered.ts) retains failed capabilities with their
declared facts and permissions. [`Budgets`](../../src/survival/state/budgets.ts) separates
fixed attempts from progress windows. Defaults give evade one 15-second attempt
and recovery one 90-second hold. A protected attack position has 300 ticks without confirmed
quarry damage. Recreating a plan, moving between refuges, healing or hitting an
incidental attacker cannot reset that position's spending.

Those thresholds are policy choices, with their names and defaults in the
[policy contract](../../src/survival/policy/contract.ts). Minecraft mechanics such as
melee reach, regeneration hunger and shield readiness remain physical facts.

## Evidence and limits

Every action reply and incident row carries derived survival status: request,
owner and reservation, dangers, response and phase, budgets, retained answers,
policy, missing observations and runtime liveness. The five durable transition
receipts are `survival_danger`, `survival_decision`, `survival_claim`,
`survival_phase` and `survival_outcome`. Raw incident recordings retain controls,
navigation, damage and velocity packets for physical diagnosis.

Automatic combat does not target players. It handles local defence and recovery;
potion strategy and automatic armor replacement are outside this capability.
Fighting cover currently uses one local arrangement, which has not qualified the
fortress collection and exit goals under multiple shooters. Future positioning
tactics can change without changing the request or ownership contracts. Native
qualification is recorded separately from package tests; consult the
[testing page](testing.md) before making a whole-job reliability claim.

## Further reading

- [Combat controller](controller.md): effects, positioning and outcomes.
- [Survival policy](survival-policy.md): the model's one control over reflexes; permissions, attribution and resumption.
- [Testing](testing.md): focused fixtures and complete-job acceptance.
