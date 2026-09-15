import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BlockPosition, WorldView } from "../world/world.js";
import { predictWaterLanding, waterableLanding } from "../world/water-landing.js";
export { predictWaterLanding, waterableLanding } from "../world/water-landing.js";
import { horizontalControlsToward } from "../steering/local-steering.js";
import { observeMineflayerBlock } from "./world.js";
import { UNLOADED } from "../world/world.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { observedEyeHeight } from "../../world/block-visibility.js";
/** Stop waiting for an unavailable server; every continuation rechecks ownership before issuing another effect. */
function whileOwned<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export interface WaterLandingEvidence {
  phase: "armed" | "poured" | "reclaiming" | "landed" | "recovered" | "failed";
  cell: BlockPosition | null;
  predictedImpactTick: number | null;
  impactTick: number | null;
  pouredTick: number | null;
  waterRecovered: boolean;
  pours: number;
  relaunchRecoveries: number;
  reason?: string;
}
const active = new WeakSet<Bot>();
export function waterLandingActive(bot: Bot): boolean { return active.has(bot); }
const outcomes = new WeakMap<Bot, {
  count: number;
  waterRecovered: number;
}>();
export function bucketDropTotals(bot: Bot) { return { ...(outcomes.get(bot) ?? { count: 0, waterRecovered: 0 }) }; }
/** The dimensions a poured source survives in; the Nether evaporates it before anything can land in it. */
export const WATER_LANDING_DIMENSIONS: readonly string[] = ["overworld", "the_end"];
/** What a water landing needs, counted once so the movement policy and the status report never disagree about why one is unavailable. */
export function waterLandingSupply(bot: Bot): { readonly waterBuckets: number; readonly dimensionHoldsWater: boolean } {
  return {
    waterBuckets: bot.inventory.items().filter(item => item.name === "water_bucket").reduce((total, item) => total + item.count, 0),
    dimensionHoldsWater: WATER_LANDING_DIMENSIONS.includes(bot.game?.dimension ?? ""),
  };
}
export function bucketAvailable(bot: Bot): boolean {
  const supply = waterLandingSupply(bot);
  return supply.waterBuckets > 0 && supply.dimensionHoldsWater;
}
function view(bot: Bot): Pick<WorldView, "blockAt"> {
  return { blockAt: (x, y, z) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      return block ? observeMineflayerBlock(block) : UNLOADED;
    } };
}
/** One already-admitted body owner owns equip, aim, controls, placement and recovery through settlement. */
export async function saveWaterLanding(bot: Bot, options: {
  signal: AbortSignal;
  permitted: () => boolean;
  target?: BlockPosition;
  observe?: (evidence: WaterLandingEvidence) => void;
}): Promise<WaterLandingEvidence> {
  const evidence: WaterLandingEvidence = { phase: "armed", cell: options.target ?? null, predictedImpactTick: null, impactTick: null, pouredTick: null, waterRecovered: false, pours: 0, relaunchRecoveries: 0 };
  const publish = () => options.observe?.({ ...evidence });
  const fail = (reason: string) => {
    evidence.phase = "failed";
    evidence.reason = reason;
    publish();
    return { ...evidence };
  };
  if (active.has(bot) || !bucketAvailable(bot) || !options.permitted())
    return fail("Water landing is unavailable or already owned.");
  const world = view(bot);
  if (options.target && !waterableLanding(world, options.target))
    return fail("The planned landing no longer has a safe full-block floor and open air.");
  const dimension = bot.game.dimension;
  const originalSlot = bot.quickBarSlot;
  const waterCount = () => bot.inventory.items().filter(item => item.name === "water_bucket").reduce((total, item) => total + item.count, 0);
  const fullBefore = waterCount();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal, AbortSignal.timeout(15000)]);
  const reset = () => lifetime.abort("Water landing lost its body or dimension.");
  const game = () => {
    if (bot.game.dimension !== dimension) reset();
  };
  let tickNumber = 0, issued = false, aiming = false, reclaiming = false, airborne = !bot.entity.onGround;
  let recoveryEpoch = 0;
  let redirected = false;
  let issueError: unknown = null;
  let usePending: Promise<void> = Promise.resolve();
  active.add(bot);
  bot.on("death", reset);
  bot.on("respawn", reset);
  bot.on("forcedMove", reset);
  bot.on("end", reset);
  bot.on("game", game);
  const check = () => {
    signal.throwIfAborted();
    if (!options.permitted()) throw new Error("Water landing permission was revoked.");
    if (!issued && waterCount() < fullBefore) throw new Error("The reserved water bucket was lost before placement.");
  };
  const selectBucket = async (name: "water_bucket" | "bucket") => {
    check();
    if (bot.currentWindow || bot.inventory.selectedItem) throw new Error("Water landing requires a closed, clear inventory cursor.");
    const item = bot.inventory.items().find(item => item.name === name);
    if (!item) throw new Error(`The reserved ${name} is unavailable.`);
    if (item.slot >= 36 && item.slot <= 44) {
      bot.setQuickBarSlot(item.slot - 36);
      return;
    }
    if (item.slot < 9 || item.slot > 35) throw new Error("The bucket is outside carried storage or the hotbar.");
    // Unlike equip -> moveSlotItem, this is one atomic number-key swap.
    // The pinned Mineflayer clickWindow writes storage-slot clicks before its
    // first await, so cancellation cannot leave queued follow-up clicks.
    await whileOwned(() => bot.clickWindow(item.slot, bot.quickBarSlot, 2), signal);
    check();
    bot.updateHeldItem();
  };
  const aimAndPour = async (cell: BlockPosition) => {
    aiming = true;
    try {
      await whileOwned(() => bot.lookAt(new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5), true), signal);
      check();
      // physicsTick fires before Mineflayer sends position. This microtask runs
      // after that packet, so the server's bucket ray starts at the observed eye.
      const latest = predictWaterLanding(bot.entity.position, bot.entity.velocity, world);
      if (bot.heldItem?.name !== "water_bucket" || !waterableLanding(world, cell) || !latest || latest.ticks > 2 ||
        latest.cell.x !== cell.x || latest.cell.y !== cell.y || latest.cell.z !== cell.z)
        return;
      bot.activateItem();
      issued = true;
      evidence.pours++;
      evidence.pouredTick = tickNumber;
      publish();
    }
    catch (error) {
      issueError = error;
    }
    finally {
      aiming = false;
    }
  };
  const sourceAt = (cell: BlockPosition) => {
    const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    return block?.name === "water" && Number(block.getProperties().level) === 0;
  };
  const reclaimAfterLaunch = async (cell: BlockPosition) => {
    recoveryEpoch++;
    redirected = true;
    reclaiming = true;
    evidence.phase = "reclaiming";
    publish();
    try {
      check();
      bot.clearControlStates();
      const point = new Vec3(cell.x + 0.5, cell.y + 0.1, cell.z + 0.5);
      const acknowledged = () => sourceAt(cell) && bot.heldItem?.name === "bucket" && waterCount() === fullBefore - 1;
      const inReach = () => bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0).distanceTo(point) <= 4.5;
      if (!inReach()) throw new Error("A new launch stranded the placed water outside recoverable reach.");
      if (!acknowledged()) {
        // Inventory can acknowledge a pour before its block packet. A native
        // failure released this owner seven milliseconds before the source
        // arrived, although the body still had reach until the next step.
        await new Promise<void>((resolve, reject) => {
          let settled = false, ticks = 0;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            bot.off("blockUpdate", observe);
            bot.off("heldItemChanged", observe);
            bot.off("move", observe);
            bot.off("physicsTick", physics);
            signal.removeEventListener("abort", observe);
            if (error !== undefined) reject(error); else resolve();
          };
          const observe = () => {
            try {
              check();
              if (!inReach()) throw new Error("The launched body lost reach before its water source was acknowledged.");
              if (acknowledged()) finish();
            } catch (error) { finish(error); }
          };
          const unconfirmed = () => finish(new Error("The issued water source and empty bucket were not acknowledged within the relaunch budget."));
          const physics = () => { observe(); if (++ticks >= 4) unconfirmed(); };
          const timeout = setTimeout(unconfirmed, 250);
          bot.on("blockUpdate", observe);
          bot.on("heldItemChanged", observe);
          bot.on("move", observe);
          bot.on("physicsTick", physics);
          signal.addEventListener("abort", observe, { once: true });
          observe();
        });
      }
      // The incoming velocity is known before the next position step. Scoop
      // only our confirmed source while the launched body is still in reach.
      await whileOwned(() => bot.lookAt(point, true), signal);
      check();
      if (!inReach()) throw new Error("The launched body lost reach of its water source.");
      if (!acknowledged()) throw new Error("The owned source or empty bucket changed before reclamation.");
      bot.activateItem();
      for (let waited = 0; waited < 4; waited++) {
        await waitForPhysicsTicks(bot, 1, signal);
        check();
        const observed = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
        if (waterCount() === fullBefore && observed && !sourceAt(cell)) {
          issued = false;
          evidence.phase = "armed";
          evidence.cell = null;
          evidence.pouredTick = null;
          evidence.impactTick = null;
          evidence.predictedImpactTick = null;
          evidence.relaunchRecoveries++;
          publish();
          return;
        }
      }
      throw new Error("The relaunched body did not confirm source removal and bucket recovery.");
    } finally { reclaiming = false; }
  };
  const launched = (packet: { entityId?: number; velocity?: { y?: number } }) => {
    if (signal.aborted || reclaiming || packet.entityId !== bot.entity.id ||
      typeof packet.velocity?.y !== "number" || !Number.isFinite(packet.velocity.y)) return;
    // Before the pour, any hit can displace a planned landing, including a
    // downward or horizontal shove. Forecast its actual destination afresh.
    if (!issued) { redirected = true; return; }
    // Reclaiming an already issued source in flight still needs upward motion.
    if (packet.velocity.y <= 4000) return;
    redirected = true;
    if (!evidence.cell) return;
    // Only a confirmed landing can already have completed its ordinary scoop.
    // Before that, missing receipts still belong to the issued pour.
    if (evidence.phase === "landed" && waterCount() === fullBefore && !sourceAt(evidence.cell)) return;
    usePending = whileOwned(() => reclaimAfterLaunch(evidence.cell!), signal).catch(error => {
      issueError = error;
      // A missing physics stream must not extend the acknowledgment deadline.
      lifetime.abort(error);
    });
  };
  const tick = () => {
    tickNumber++;
    if (signal.aborted)
      return;
    try { check(); }
    catch (error) { issueError = error; return; }
    if (reclaiming) return;
    airborne ||= !bot.entity.onGround;
    const prediction = !issued ? predictWaterLanding(bot.entity.position, bot.entity.velocity, world) : null;
    if (!issued) {
      evidence.cell = (!redirected ? options.target : null) ?? prediction?.cell ?? null;
      evidence.predictedImpactTick = prediction ? tickNumber + prediction.ticks : null;
    }
    const cell = evidence.cell;
    if (!cell) {
      bot.clearControlStates();
      return;
    }
    const anchor = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
    const brakingPosition = bot.entity.position.offset(bot.entity.velocity.x * (bot.entity.onGround ? 2 : 6), 0, bot.entity.velocity.z * (bot.entity.onGround ? 2 : 6));
    const controls = horizontalControlsToward({ position: brakingPosition, yaw: bot.entity.yaw }, anchor, 0.06);
    for (const control of ["forward", "back", "left", "right"] as const)
      bot.setControlState(control, controls[control]);
    bot.setControlState("jump", false);
    bot.setControlState("sprint", false);
    bot.setControlState("sneak", false);
    if (airborne && bot.entity.onGround && evidence.impactTick === null)
      evidence.impactTick = tickNumber;
    if (!issued && !aiming && prediction && prediction.ticks <= 2 && !bot.entity.onGround && bot.entity.velocity.y < 0 && bot.heldItem?.name === "water_bucket") {
      const eye = bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0);
      if (eye.distanceTo(new Vec3(anchor.x, cell.y, anchor.z)) <= 4.5)
        usePending = whileOwned(() => aimAndPour(cell), signal).catch(error => { issueError = error; });
    }
  };
  try {
    check();
    bot.clearControlStates();
    bot.deactivateItem();
    await selectBucket("water_bucket");
    check();
    bot.on("physicsTick", tick);
    bot._client?.on("entity_velocity", launched);
    tick();
    publish();
    flight: for (let waited = 0; waited < 200; waited++) {
      check();
      if (issueError)
        throw issueError;
      if (reclaiming) { await waitForPhysicsTicks(bot, 1, signal); continue; }
      const cell = evidence.cell;
      if (issued && cell) {
        const source = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
        if (source?.name === "water" && Number(source.getProperties().level) === 0 && bot.heldItem?.name === "bucket" && waterCount() === fullBefore - 1)
          evidence.phase = "poured";
        if (evidence.phase === "poured" && bot.entity.onGround && bot.entity.position.y <= cell.y + 0.05 && Reflect.get(bot.entity, "isInWater")) {
          const landingEpoch = recoveryEpoch;
          evidence.phase = "landed";
          publish();
          // Never scoop midfall: wet feet alone do not prove fall distance was reset on the server.
          await waitForPhysicsTicks(bot, 2, signal);
          check();
          if (landingEpoch !== recoveryEpoch) continue;
          const empty = bot.inventory.items().find(item => item.name === "bucket");
          if (!empty)
            return fail("No empty bucket remained for recovery.");
          await selectBucket("bucket");
          check();
          if (landingEpoch !== recoveryEpoch) continue;
          await whileOwned(() => bot.lookAt(new Vec3(cell.x + 0.5, cell.y + 0.1, cell.z + 0.5), true), signal);
          check();
          if (landingEpoch !== recoveryEpoch) continue;
          bot.activateItem();
          for (let recovery = 0; recovery < 40; recovery++) {
            await waitForPhysicsTicks(bot, 1, signal);
            check();
            if (landingEpoch !== recoveryEpoch) continue flight;
            const after = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
            if (waterCount() === fullBefore && after && !(after.name === "water" && Number(after.getProperties().level) === 0)) {
              evidence.waterRecovered = true;
              evidence.phase = "recovered";
              publish();
              return { ...evidence };
            }
          }
          return fail("The source removal and filled bucket were not both observed.");
        }
      }
      if (bot.entity.onGround && evidence.impactTick !== null && tickNumber - evidence.impactTick >= 4)
        return fail("The grounded landing did not confirm water protection.");
      if (airborne && bot.entity.onGround && !issued)
        return fail("Landed before water could be placed.");
      await waitForPhysicsTicks(bot, 1, signal);
    }
    return fail("Water landing did not settle within its fixed budget.");
  }
  finally {
    const restoreSelection = !signal.aborted && bot.health > 0 && dimension === bot.game.dimension;
    bot.off("physicsTick", tick);
    bot._client?.off("entity_velocity", launched);
    lifetime.abort("Water landing settled.");
    await usePending.catch(() => { });
    bot.off("death", reset);
    bot.off("respawn", reset);
    bot.off("forcedMove", reset);
    bot.off("end", reset);
    bot.off("game", game);
    active.delete(bot);
    bot.clearControlStates();
    bot.deactivateItem();
    if (restoreSelection) bot.setQuickBarSlot(originalSlot);
    if (options.target && evidence.pours > 0) {
      const totals = bucketDropTotals(bot);
      totals.count += evidence.pours;
      totals.waterRecovered += evidence.relaunchRecoveries + Number(evidence.waterRecovered);
      outcomes.set(bot, totals);
    }
  }
}
