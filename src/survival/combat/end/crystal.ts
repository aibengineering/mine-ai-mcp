import { findCrystalOpenings } from "../../positioning/combat/crystal-openings.js";
import { buildCrystalStaircase, pillarShortfall, planCrystalStaircase } from "../../positioning/combat/crystal-staircase.js";
import { Vec3 } from "vec3";
import { createMovements, exactBlockGoal, nearXzGoal, packKey, type Goal } from "../../../navigation/index.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { breathBesideFeet, breathOverStances, dragonExposure, perchedDragonContact, readDragonCloudHazards } from "../../../world/dragon-hazards.js";
import { dragonPhase, isDragonPerched } from "../../../world/end-fight.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import { endermanGazeRisk } from "../../perception/combat/gaze.js";
import { decideEndResponse } from "../../policy/combat/end-decision.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { DRAGON_PROTECTION_BLOCKS } from "../../positioning/combat/hide-blocks.js";
import { crystalBlastCoverCell, crystalBlastEstimate, crystalMeleeAim, crystalMeleeObstruction, crystalReturnGoal } from "../../positioning/combat/crystal-melee.js";
import { bowTrajectory, clearBowTrajectory } from "../../positioning/combat/bow-trajectory.js";
import { CombatItemUse } from "../../weapons/item-use.js";
import type { CrystalStaircase, CrystalObservation } from "../../perception/combat/crystal.js";
import { equipCombatLoadout, readCombatItems, selectRangedLoadout } from "../../weapons/equipment.js";
import { EndCore, type EndCombatResult, type EndMoveResult } from "./core.js";

/** Health points held back beyond the blast estimate before an exposed swing. */
const CRYSTAL_BLAST_MARGIN = 2;
/** Blocks one melee request may dig off its attack line: a shelter's walls and cap are at most a few. */
const CRYSTAL_LINE_DIGS = 6;
/** A perched cloud lives ten seconds of server time and a fireball's thirty; a loaded server stretches both. */
const CRYSTAL_BREATH_WAIT_MS = 45_000;
/** A native perch takes off after at most four ten-second flamings, with scans
 * and roars between; the margin covers a loaded server stretching them. */
const CRYSTAL_PERCH_WAIT_MS = 90_000;
// Vanilla ServerLevel sends explosion packets only when distance squared is
// below 4096. Beyond this range a destroyed crystal can vanish without a receipt.
const EXPLOSION_RECEIPT_RANGE = 64;

/** Destroys one End crystal: shoot it, or climb and swing, waiting out breath and perches. */
export class CrystalAttack {
  constructor(private readonly end: EndCore) {}

  async crystal(targetId: number, signal: AbortSignal, observation: CrystalObservation): Promise<EndCombatResult> {
    const bot = this.end.bot;
    if (bot.game.dimension !== observation.dimension)
      return this.crystalResult(observation, "stopped", "Dimension changed during this crystal request.");
    const loadedTarget = bot.entities[targetId];
    if (loadedTarget && loadedTarget !== observation.target && !observation.destroyed)
      return this.crystalResult(observation, "stopped", "The selected crystal identity is no longer observed.");
    // A released arrow and its receipts survive body takeovers. Never fire a
    // second arrow simply because the first attempt yielded to a reflex.
    if (observation.meleeReturn) return this.climbToCrystal(signal, observation);
    if (observation.destroyed || observation.shot) return this.observeCrystalShot(observation, signal);
    const target = bot.entities[targetId];
    if (!target?.isValid || target.name !== "end_crystal")
      return this.crystalResult(observation, "stopped", "Selected end crystal is not loaded");
    const rangedAvailable = () =>
      selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.end.policy().combat)) !== null &&
      bot.inventory.items().some((i) => i.name === "arrow");
    if (observation.usedWeapon === null) {
      if (observation.weapon === "bow") {
        if (!this.end.policy().combat.bow)
          return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Bow use is prohibited.");
        if (!rangedAvailable())
          return this.crystalResult(
            observation,
            "weapon_unavailable",
            "[CRYSTAL_BOW_UNAVAILABLE] Explicit bow requires a permitted carried bow and at least one arrow.",
          );
        observation.usedWeapon = "bow";
        observation.phase = "approaching";
      } else if (observation.weapon === "melee" || !rangedAvailable()) {
        observation.beginMelee();
        return this.climbToCrystal(signal, observation);
      } else {
        observation.usedWeapon = "bow";
        observation.phase = "approaching";
      }
    }
    if (observation.usedWeapon === "melee") return this.climbToCrystal(signal, observation);
    if (!this.end.policy().combat.bow)
      return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Bow use is prohibited.");
    const aim = target.position.offset(0, 1.75, 0);
    // A power-six crystal explosion reaches twelve blocks. Keep the firing
    // body beyond that radius rather than relying on unverified blast cover.
    const canShoot = (feet: Vec3) => {
      const distance = feet.distanceTo(target.position);
      if (
        distance < 13 ||
        distance >= EXPLOSION_RECEIPT_RANGE ||
        dragonExposure(bot, feet) > 0 ||
        perchedDragonContact(bot, feet)
      )
        return false;
      // Vanilla arrows start one tenth below the eyes. The lower parallel ray
      // leaves clearance for spread: native high shots otherwise clipped the
      // pillar's upper edge even with a nominally clear center trajectory.
      const trajectory = bowTrajectory(feet.offset(0, 1.52, 0), aim);
      return (
        trajectory !== null &&
        !endermanGazeRisk(
          bot,
          feet,
          Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z),
          Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z)),
        ) &&
        clearBowTrajectory(trajectory, (p, d, n) => {
          const hit = bot.world.raycast(p, d, n);
          if (hit) return hit;
          // A full block is a pillar ledge; narrow cage bars still use their
          // actual shape, since inflating them would close every firing slit.
          return bot.world.raycast(p.offset(0, -0.5, 0), d, n, (block) =>
            block.shapes.some((s) => s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1),
          );
        })
      );
    };
    const use = new CombatItemUse(bot, async (ticks) => {
      for (let i = 0; i < ticks; i++) await this.end.tick(signal);
    });
    // A route ends within its cell, not at its exact center. Remember a cell
    // whose actual arrival lost the narrow cage sightline so the next search
    // must choose a different firing stance instead of returning there forever.
    const unusableStances = new Set<string>();
    try {
      for (;;) {
        signal.throwIfAborted();
        if (observation.destroyed) return this.observeCrystalShot(observation, signal);
        if (!target.isValid) return this.crystalResult(observation, "stopped", "Selected crystal is no longer observed");
        const response = decideEndResponse(this.end.policy().combat, this.end.danger, "crystal");
        if (response.kind === "constrained") return this.crystalResult(observation, "stopped", response.reason);
        if (!rangedAvailable()) {
          if (observation.weapon === "auto") {
            observation.beginMelee();
            return await this.climbToCrystal(signal, observation);
          }
          return this.crystalResult(
            observation,
            "weapon_unavailable",
            "[CRYSTAL_BOW_UNAVAILABLE] Explicit bow requires a permitted carried bow and at least one arrow.",
          );
        }
        if (response.kind === "evade") {
          const escaped = await this.end.evade(signal);
          if (escaped.outcome !== "evaded") return this.crystalResult(observation, "stopped", escaped.reason);
        }
        const foodFailure = await this.end.eatForRegeneration(signal);
        if (foodFailure) return this.crystalResult(observation, "stopped", foodFailure);
        while (!canShoot(bot.entity.position)) {
          // Give navigation actual firing openings to approach, rather than
          // the tower itself. Reachability remains the pathfinder's decision.
          const openings = await findCrystalOpenings({
            world: this.end.navigation.world, columns: bot.world.getColumns(),
            origin: bot.entity.position.clone(), target: target.position.clone(),
            receiptRange: EXPLOSION_RECEIPT_RANGE, signal,
            canShoot: feet => !unusableStances.has(`${Math.floor(feet.x)},${feet.y},${Math.floor(feet.z)}`) && canShoot(feet),
            interrupted: () => this.end.danger || !target.isValid || observation.destroyed ||
              bot.game.dimension !== observation.dimension || bot.entities[targetId] !== target,
          });
          if (bot.game.dimension !== observation.dimension || (bot.entities[targetId] && bot.entities[targetId] !== target && !observation.destroyed))
            return this.crystalResult(observation, "stopped", "Selected crystal or its dimension is no longer observed.");
          if (!target.isValid || !bot.entities[targetId] || observation.destroyed) return this.observeCrystalShot(observation, signal);
          if (openings === null) {
            const escaped = await this.end.evade(signal);
            if (escaped.outcome !== "evaded") return this.crystalResult(observation, "stopped", escaped.reason);
            continue;
          }
          const goal: Goal = {
            resolve: () => ({
              kind: "active",
              revision: `crystal-shot:${targetId}`,
              // With no sampled opening, keep searching reachable cells.
              heuristic: ({ feet }) => openings.length === 0 ? 0 : Math.min(...openings.map(cell =>
                Math.hypot(feet.x - cell.x, feet.y - cell.y, feet.z - cell.z))),
              isSatisfied: ({ feet }) =>
                !unusableStances.has(`${feet.x},${feet.y},${feet.z}`) &&
                canShoot(new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)),
            }),
          };
          const stopped = await this.end.move(goal, signal, () => this.end.danger || !target.isValid || observation.destroyed);
          if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
          if (stopped.kind !== "arrived") {
            if (this.end.danger) {
              const escaped = await this.end.evade(signal);
              if (escaped.outcome !== "evaded") return this.crystalResult(observation, "stopped", escaped.reason);
            } else if (stopped.kind === "failed") return this.crystalResult(observation, "stopped", stopped.reason);
          }
          await this.end.tick(signal);
          if (stopped.kind === "arrived" && !canShoot(bot.entity.position)) {
            const feet = bot.entity.position.floored();
            unusableStances.add(`${feet.x},${feet.y},${feet.z}`);
          }
        }
        const loadout = selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.end.policy().combat));
        if (!loadout || !bot.inventory.items().some((i) => i.name === "arrow")) continue;
        await equipCombatLoadout(bot, loadout);
        if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
        const trajectory = bowTrajectory(bot.entity.position.offset(0, 1.52, 0), aim);
        if (!trajectory)
          return this.crystalResult(observation, "stopped", "No full-charge arrow trajectory reaches this crystal");
        let interrupted = false;
        const drawn = await this.end.phase("shoot", async () => {
          using draw = use.drawBow();
          // The use packet can arrive after this client's current physics tick.
          // One extra tick ensures the server has the full twenty-tick draw.
          for (let ticks = 0; ticks < 21; ticks++) {
            if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
            if (this.end.danger || !canShoot(bot.entity.position)) {
              interrupted = true;
              break;
            }
            await bot.look(
              Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z),
              Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z)),
              true,
            );
            await this.end.tick(signal);
          }
          if (!target.isValid || observation.destroyed) return this.observeCrystalShot(observation, signal);
          if (!interrupted && (this.end.danger || !canShoot(bot.entity.position))) interrupted = true;
          if (!interrupted) {
            observation.phase = "aiming";
            observation.released(trajectory.points.length - 1);
            observation.beginBlastObservation();
            draw.release();
          }
        });
        if (drawn) return drawn;
        if (interrupted) continue;
        break;
      }
    } finally {
      await use.neutralise(async () => {
        if (!signal.aborted) await this.end.settle(signal);
      }, signal);
    }
    // Keep request listeners alive through item cleanup and reconcile AFTER it.
    return this.observeCrystalShot(observation, signal);
  }

  private async observeCrystalShot(observation: CrystalObservation, signal: AbortSignal): Promise<EndCombatResult> {
    observation.beginBlastObservation();
    return this.end.phase("observe_shot", () => this.reconcileCrystalShot(observation, signal));
  }

  private async reconcileCrystalShot(observation: CrystalObservation, signal: AbortSignal): Promise<EndCombatResult> {
    while (!observation.destroyed && observation.shot && !observation.shot.settled) {
      signal.throwIfAborted();
      if (this.end.bot.game.dimension !== observation.dimension)
        return this.crystalResult(observation, "stopped", "Dimension changed while observing the crystal shot");
      if (this.end.danger) {
        const escape = await this.end.evade(signal);
        if (escape.outcome !== "evaded") return this.crystalResult(observation, "stopped", escape.reason);
      }
      await this.end.tick(signal);
    }
    signal.throwIfAborted();
    let loaded =
      this.end.bot.game.dimension === observation.dimension &&
      this.end.bot.entities[observation.targetId] === observation.target &&
      observation.target?.isValid;
    if (!observation.destroyed && !loaded && observation.shot && observation.target) {
      const site = observation.target.position;
      // A native pedestal provides a stable place to revisit after a retreat.
      const pedestal = this.end.bot.blockAt(site.offset(0, -1, 0));
      if (observation.nativePedestalObserved || pedestal?.name === "bedrock" || pedestal?.name === "obsidian") {
        for (;;) {
          signal.throwIfAborted();
          if (this.end.bot.game.dimension !== observation.dimension)
            return this.crystalResult(observation, "stopped", "Dimension changed while rechecking the crystal site");
          if (observation.destroyed) break;
          if (this.end.danger) {
            const escape = await this.end.evade(signal);
            if (escape.outcome !== "evaded") return this.crystalResult(observation, "stopped", escape.reason);
          }
          const moved = await this.end.move(nearXzGoal(site, 24), signal,
            () => this.end.danger || observation.destroyed || this.end.bot.game.dimension !== observation.dimension);
          if (moved.kind === "failed") { await this.end.tick(signal); continue; }
          if (moved.kind !== "arrived") continue;
          // Fresh server time after returning allows tracked entities to arrive.
          const age = this.end.bot.time.age;
          while (this.end.bot.time.age - age < 40 && !this.end.danger && !observation.destroyed) await this.end.tick(signal);
          if (this.end.danger) continue;
          if (this.end.bot.game.dimension !== observation.dimension) continue;
          if (observation.destroyed) break;
          if (Math.hypot(this.end.bot.entity.position.x - site.x, this.end.bot.entity.position.z - site.z) > 32) continue;
          if (!this.end.bot.blockAt(site) || !this.end.bot.blockAt(site.offset(0, -1, 0))) continue;
          const remaining = Object.values(this.end.bot.entities).some(entity => entity.isValid && entity.name === "end_crystal" && entity.position.distanceTo(site) < 2);
          if (!remaining) {
            observation.destroyed = true;
            observation.phase = "settled";
            return this.crystalResult(observation, "crystal_destroyed", "Returned to the loaded crystal site and verified it empty after fresh server updates.");
          }
          loaded = true;
          break;
        }
      }
    }
    observation.phase = "settled";
    return this.crystalResult(
      observation,
        observation.destroyed ? "crystal_destroyed" : loaded ? "shot_missed" : "stopped",
        observation.destroyed
          ? null
          : loaded
            ? "Crystal remains loaded after the server observed the shot's flight window"
            : "Crystal left observation without a destruction receipt; the shot is unconfirmed",
      );
  }

  private crystalResult(
    observation: CrystalObservation,
    outcome: EndCombatResult["outcome"],
    reason: string | null = null,
  ): EndCombatResult {
    return {
      ...this.end.result(outcome, reason),
      attacks: observation.attacks,
      crystal: {
        weapon: observation.weapon,
        approach: observation.approach,
        usedWeapon: observation.usedWeapon,
        phase: observation.phase,
        melee: observation.meleeEvidence(),
      },
    };
  }

  private async climbToCrystal(signal: AbortSignal, observation: CrystalObservation): Promise<EndCombatResult> {
    observation.beginMelee();
    if (!this.end.policy().combat.melee)
      return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
    const bot = this.end.bot,
      crystal = observation.target;
    if (!crystal || (!crystal.isValid && !observation.destroyed && !observation.shot))
      return this.crystalResult(observation, "stopped", "Selected crystal is no longer observed");
    const start = (observation.meleeReturn ??= bot.entity.position.floored());
    const pedestal = crystal.position.offset(0, -1, 0).floored();
    // Walking and returning preserve the reusable treads; only the builder
    // places the declared staircase, so supply estimates exclude hidden routes.
    // The pillar approach is the exception: its route is the scaffolding, and
    // the descent digs back through it. The tower stays protected either way.
    const pillar = observation.approach === "pillar";
    const protectedCells = () => new Set([packKey(pedestal.x, pedestal.y, pedestal.z),
      ...(observation.staircase?.tower.map(p => packKey(p.x, p.y, p.z)) ?? []),
      ...(observation.staircase?.cells.filter(cell => cell.blockName !== "air")
        .map(({ position: p }) => packKey(p.x, p.y, p.z)) ?? [])]);
    const movements = () => createMovements(bot, {
      allowDigging: this.end.policy().combat.terrain.dig, scaffolding: pillar && this.end.policy().combat.terrain.place,
      protectedCells: protectedCells(),
    });
    // What the bot itself may have left on the attack line: shelter walls and
    // caps, or scaffold. The tower, its pedestal, its cage and the treads stay.
    const placedByBot = (position: Vec3) => {
      const block = bot.blockAt(position);
      return block !== null && block.name !== "bedrock" && !protectedCells().has(packKey(position.x, position.y, position.z)) &&
        (DRAGON_PROTECTION_BLOCKS.includes(block.name) || this.end.policy().navigation.scaffold_blocks.includes(block.name));
    };
    let lineDigs = 0;
    while (!observation.destroyed && !observation.shot) {
      signal.throwIfAborted();
      // An approach pass answers a lost crystal with "changed" before any real
      // wait; without this check the climb re-entered itself and never yielded.
      if (!crystal.isValid) return this.crystalResult(observation, "stopped", "Selected crystal is no longer observed");
      if (this.end.danger) {
        const escape = await this.end.evade(signal);
        if (escape.outcome !== "evaded") {
          observation.fail("dragon_contact");
          return this.crystalResult(observation, "stopped", escape.reason);
        }
      }
      const foodFailure = await this.end.eatForRegeneration(signal);
      if (foodFailure) return this.crystalResult(observation, "stopped", foodFailure);
      try { observation.staircase ??= planCrystalStaircase(bot, crystal.position); }
      catch (error) { return this.crystalResult(observation, "stopped", String(error)); }
      if (pillar) {
        const short = pillarShortfall(bot, this.end.policy(), observation.staircase);
        if (short) return this.crystalResult(observation, "stopped", short);
      } else {
        const built = await this.buildCrystalApproach(observation, signal);
        if (built.kind === "changed") continue;
        if (built.kind === "failed") {
          if (await this.breathPassed(signal, observation.staircase)) continue;
          return this.crystalResult(observation, "stopped", built.reason);
        }
      }
      const moved = await this.end.move(exactBlockGoal(observation.staircase.stance), signal,
        () => this.end.danger || !crystal.isValid, movements());
      if (moved.kind === "failed") {
        observation.fail("stance_unreachable");
        return this.crystalResult(observation, "stopped", moved.reason);
      }
      if (!crystal.isValid) return this.crystalResult(observation, "stopped", "Crystal disappeared before the melee attack");
      if (moved.kind === "changed") continue;
      const feet = bot.entity.position.clone();
      const aim = crystalMeleeAim(bot, crystal.position);
      if (!aim) {
        // A dragon shelter raised on the stance leaves its walls and cap
        // between the eye and the crystal; dig them out rather than refuse
        // every retry from the same cell.
        const obstruction = this.end.policy().combat.terrain.dig && lineDigs < CRYSTAL_LINE_DIGS
          ? crystalMeleeObstruction(bot, crystal.position, feet.offset(0, observedEyeHeight(bot.entity), 0), placedByBot)
          : null;
        if (obstruction) {
          lineDigs++;
          const dug = await this.end.phase("approach", () =>
            this.end.navigation.breakBlockInPlace({ position: obstruction, movements: movements(), signal }));
          if (dug.status === "broken") continue;
        }
        observation.fail("cage_uncleared");
        return this.crystalResult(observation, "stopped", "[CRYSTAL_ATTACK_CORNER_BLOCKED] The staircase is complete but the stance lacks a clear melee hit within reach. Inspect the cage opening before retrying.");
      }
      // An exposed stance on the tower top must leave the body out of the
      // critical band after the blast. A live swing lost 5.7 health against an
      // estimate of 5.3, so the estimate is close rather than pessimistic;
      // the margin covers the body standing off the cell centre.
      const floor = this.end.policy().combat.critical_health;
      const blastUnsafe = (estimate: ReturnType<typeof crystalBlastEstimate>) =>
        !estimate.covered && bot.health - estimate.damage - CRYSTAL_BLAST_MARGIN <= floor;
      const blast = crystalBlastEstimate(bot, crystal.position, feet);
      if (blastUnsafe(blast)) {
        observation.fail("blast_unsafe");
        return this.crystalResult(observation, "stopped", `[CRYSTAL_BLAST_UNSAFE] The swing stance on the tower top is exposed to the crystal blast: estimated ${blast.damage.toFixed(1)} damage after armor (exposure ${blast.exposure.toFixed(2)}, ${blast.rawDamage} raw) plus a ${CRYSTAL_BLAST_MARGIN} point margin at health ${bot.health} would end at or below critical_health ${floor}. Heal, wear stronger armor, or destroy this crystal with the bow; the tower is not mined for cover.`);
      }
      await bot.lookAt(aim, true);
      // The dragon can move us while aiming. Never swing on a stale stance.
      if (this.end.danger || !bot.entity.onGround) continue;
      if (!crystalMeleeAim(bot, crystal.position)) continue;
      // Native explosions retain one point of raw damage even at zero exposure.
      if (bot.health <= 1)
        return this.crystalResult(observation, "stopped", "Too little health for the crystal explosion's minimum damage");
      if (!this.end.policy().combat.melee)
        return this.crystalResult(observation, "stopped", "[COMBAT_CONSTRAINED] Melee is prohibited.");
      const finalBlast = crystalBlastEstimate(bot, crystal.position, bot.entity.position);
      if (blastUnsafe(finalBlast)) continue;
      observation.recordSwing(
        bot.entity.position.floored().equals(observation.staircase.stance),
        bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0).distanceTo(aim),
        { cover: crystalBlastCoverCell(bot, crystal.position, bot.entity.position), exposure: finalBlast.exposure, damage: finalBlast.damage },
      );
      observation.released(0);
      observation.beginBlastObservation();
      bot.attack(crystal);
    }
    const receipt = await this.observeCrystalShot(observation, signal);
    if (receipt.outcome !== "crystal_destroyed") return receipt;
    observation.beginReturn();
    const perchDeadline = Date.now() + CRYSTAL_PERCH_WAIT_MS;
    for (;;) {
      if (this.end.danger) {
        const escape = await this.end.evade(signal);
        if (escape.outcome !== "evaded") {
          observation.fail("dragon_contact");
          return {
            ...this.crystalResult(observation, "stopped", `Crystal destroyed; return interrupted: ${escape.reason}`),
          };
        }
      }
      // The walk home can cross the fountain while the dragon sits on it. An
      // unrestricted route stepped up into the perched wing's reach, the
      // escape stepped one block down out of it, and the two alternated until
      // the take-off launched the body. Route around that reach as the head
      // approach does; when it closes every route, wait for the perch to change.
      const descended = await this.end.move(crystalReturnGoal(start), signal, () => this.end.danger,
        this.end.avoidingDragon(movements()));
      if (descended.kind === "changed") continue;
      if (descended.kind === "failed" && await this.perchChanged(signal, perchDeadline)) continue;
      observation.finishReturn(descended.kind === "arrived");
      return descended.kind === "arrived"
        ? this.crystalResult(observation, "crystal_destroyed")
        : this.crystalResult(observation, "stopped", `Crystal destroyed; return route failed: ${descended.reason}`);
    }
  }

  /**
   * A perched dragon's breath settled on the floor beside the raised cell the
   * bot stood on: not exposed, so no escape ran, but navigation refuses every
   * step into the breath, and the staircase read its closed routes as
   * unreachable treads. A fireball's cloud on a tread above the bot closes the
   * one-wide staircase the same way. Wait for that breath to go, then build again.
   */
  private async breathPassed(signal: AbortSignal, staircase: CrystalStaircase | null): Promise<boolean> {
    const treads = staircase?.cells.filter(cell => cell.blockName === "air").map(cell => cell.position) ?? [];
    const beside = [...breathBesideFeet(this.end.bot, this.end.bot.entity.position), ...breathOverStances(this.end.bot, treads)]
      .map(cloud => cloud.id);
    if (beside.length === 0) return false;
    for (const deadline = Date.now() + CRYSTAL_BREATH_WAIT_MS; Date.now() < deadline;) {
      // Danger or lost footing is a changed scene the approach loop answers itself.
      if (this.end.danger || this.end.footing.needed) return true;
      const present = new Set(readDragonCloudHazards(this.end.bot).map(cloud => cloud.id));
      if (beside.every(id => !present.has(id))) return true;
      await waitForPhysicsTicks(this.end.bot, 5, signal);
    }
    return false;
  }

  /**
   * A perched dragon's reach can close every return route from the clear cell
   * the body stands on. Hold that cell until the perch changes (a turn moves
   * the wings, a take-off ends it) or danger arrives, then route again. False
   * when no dragon is perched, or the perch outlasts `deadline`.
   */
  private async perchChanged(signal: AbortSignal, deadline: number): Promise<boolean> {
    const pose = () => JSON.stringify(Object.values(this.end.bot.entities)
      .filter(entity => entity.isValid && entity.name === "ender_dragon" && isDragonPerched(dragonPhase(this.end.bot, entity)))
      .map(entity => [entity.id, entity.position.x.toFixed(1), entity.position.y.toFixed(1), entity.position.z.toFixed(1), entity.yaw.toFixed(2)]));
    const perched = pose();
    if (perched === "[]") return false;
    while (Date.now() < deadline) {
      if (this.end.danger || this.end.footing.needed || pose() !== perched) return true;
      await waitForPhysicsTicks(this.end.bot, 5, signal);
    }
    return false;
  }

  private async buildCrystalApproach(observation: CrystalObservation, signal: AbortSignal): Promise<EndMoveResult> {
    await this.end.settle(signal);
    const stop = new AbortController();
    const watch = () => {
      if (this.end.danger || this.end.footing.needed || !observation.target?.isValid) stop.abort("Crystal staircase interrupted by changing danger or footing");
    };
    this.end.bot.on("physicsTick", watch);
    try {
      watch();
      if (stop.signal.aborted) return { kind: "changed" };
      const failure = await this.end.phase("approach", () => buildCrystalStaircase(this.end.bot, this.end.navigation,
        this.end.policy(), observation.staircase!, AbortSignal.any([signal, stop.signal])));
      return failure ? { kind: "failed", reason: failure } : { kind: "arrived" };
    } catch (error) {
      signal.throwIfAborted();
      if (stop.signal.aborted) return { kind: "changed" };
      throw error;
    } finally { this.end.bot.off("physicsTick", watch); }
  }
}
