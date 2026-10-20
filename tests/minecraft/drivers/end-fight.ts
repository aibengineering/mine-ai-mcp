/**
 * The caller of an End fight: what a player asking for crystals and perches
 * would request, read back through view_status. The fixture's YAML arranges
 * the fight (crystals removed, the dragon held, wounded or released) with
 * `schedule:`; this driver only confirms that arrangement before its first
 * request, so a stimulus that never appears fails instead of passing idle.
 *
 * Stages run in order, each optional:
 * - `policy` and `before`: the recorded first-entry caller's own requests.
 * - `crystals`: one destroy_end_crystal per crystal with its assigned method,
 *   at most `attempts` times while view_status still lists that crystal.
 * - `dragon`: the perch loop, the bow loop, or one perch request with an
 *   expected result, until view_status no longer lists the dragon.
 * - `watch`: request nothing and observe that the dragon reaches the phases
 *   the arrangement provokes, for an idle reflex fixture.
 *
 * World goals carry the verdict. Each body request waits, observing with
 * view_status, until no reflex owns the body, and is then made once; a
 * refusal is never re-sent.
 */
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { DRAGON_PHASE_NAMES, viewStatusResultSchema, type LiveSituation } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioCall, ScenarioContext } from "../scenario.ts";

const phaseSchema = z.enum(DRAGON_PHASE_NAMES);

const fightSchema = z.strictObject({
  /** Ticks for the scheduled arrangement to land before it is checked. */
  waitTicks: ticksSchema.default(20),
  /** What view_status must show before the first request. */
  arranged: z.strictObject({
    crystals: z.number().int().nonnegative(),
    dragonHealth: z.number().positive().optional(),
    dragonPhases: z.array(phaseSchema).min(1).optional(),
    clouds: z.number().int().positive().optional(),
    mobs: z.array(z.string().min(1)).min(1).optional(),
    /** Worn or carried stacks at a recorded damage, applied by the fixture at the start. */
    damaged: z.array(z.strictObject({ item: z.string().min(1), damage: z.number().int().positive() })).min(1).optional(),
  }),
  /** Ticks between consecutive fight requests. */
  gapTicks: ticksSchema.default(20),
  /** The longest a reflex may hold the body before a request fails the trial. */
  idleWithinTicks: ticksSchema.default(1200),
  policy: z.strictObject({ changes: z.record(z.string(), z.unknown()), reason: z.string().min(1) }).optional(),
  before: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    expect: expectationSchema,
  })).optional(),
  crystals: z.strictObject({
    /**
     * every_method: caged crystals by height get bow, then staircase; the
     * exposed ones above the two lowest get the bow; the two lowest exposed
     * ones get the pillar, last.
     * pillar_then_staircase: the exposed crystals by height get pillar, pillar,
     * staircase, staircase, then bow; the caged ones bow, then staircase.
     * mixed: bow on every exposed crystal, then staircase on the caged ones.
     * melee: staircase on every crystal, lowest first.
     */
    plan: z.enum(["every_method", "pillar_then_staircase", "mixed", "melee"]),
    attempts: z.number().int().positive().default(3),
    /** Before each crystal, collect this block up to `keep`, then walk back to the start. */
    resupply: z.strictObject({ block: z.string().min(1), keep: z.number().int().positive(), batch: z.number().int().positive() }).optional(),
  }).optional(),
  dragon: z.discriminatedUnion("attack", [
    z.strictObject({ attack: z.literal("perch") }),
    z.strictObject({ attack: z.literal("bow"), hitboxMargin: z.number().min(0).max(1.25).default(0.5) }),
    z.strictObject({ attack: z.literal("perch_once"), expect: expectationSchema }),
  ]).optional(),
  watch: z.strictObject({
    ticks: z.number().int().positive(),
    every: z.number().int().positive().default(5),
    /** At least one of these phases must be observed during the watch. */
    phases: z.array(phaseSchema).min(1),
  }).optional(),
});
type Fight = z.output<typeof fightSchema>;

/** The fields of an End combat receipt this caller reads. */
const endCombatSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  combat: z.object({
    outcome: z.string(),
    reason: z.string().nullable(),
    crystal: z.object({ usedWeapon: z.string().nullable() }).optional(),
  }).optional(),
});

type Method = { weapon: "bow" | "melee"; approach: "staircase" | "pillar" };
type Crystal = LiveSituation["endFight"]["crystals"][number];
type Dragon = LiveSituation["endFight"]["dragons"][number];
type Position = { x: number; y: number; z: number };

/** A verdict the caller reached; anything else is a host error. */
class Failure extends Error {}

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const fight = playerParams(context, fightSchema);
  const caller = new Caller(context, fight.gapTicks, fight.idleWithinTicks);
  try {
    await context.waitForTicks(fight.waitTicks);
    await caller.checkArrangement(fight.arranged);
    if (fight.policy) await caller.setPolicy(fight.policy);
    for (const step of fight.before ?? []) {
      const output = await caller.request(step.action, step.input);
      const { matches, detail } = checkExpectation(step.expect, output);
      caller.note(detail.slice(0, 200));
      if (!matches) throw new Failure(`${step.action} did not meet its expectation`);
    }
    if (fight.crystals) await caller.clearCrystals(fight.crystals, start(context));
    if (fight.dragon?.attack === "perch") await caller.perchUntilDead();
    if (fight.dragon?.attack === "bow") await caller.shootUntilDead(fight.dragon.hitboxMargin, start(context));
    if (fight.dragon?.attack === "perch_once") await caller.perchOnce(fight.dragon.expect);
    if (fight.watch) await caller.watch(fight.watch);
    return { status: "succeeded", detail: caller.summary() };
  } catch (cause) {
    if (!(cause instanceof Failure)) throw cause;
    return { status: "failed", detail: `${cause.message}; ${caller.summary()}` };
  }
}

/** The declared start, as the block cell a return walk aims for. */
function start(context: ScenarioContext): Position {
  const pos = context.scenario.players.find(({ name }) => name === context.username)?.pos;
  if (!Array.isArray(pos)) throw new Error(`The fixture declares no absolute pos for ${context.username}.`);
  return { x: Math.floor(pos[0]), y: Math.floor(pos[1]), z: Math.floor(pos[2]) };
}

class Caller {
  readonly #context: ScenarioContext;
  readonly #gapTicks: number;
  readonly #notes: string[] = [];
  readonly #idleWithinTicks: number;
  readonly #waits = { count: 0, longest: 0, total: 0 };
  #requests = 0;

  constructor(context: ScenarioContext, gapTicks: number, idleWithinTicks: number) {
    this.#context = context;
    this.#gapTicks = gapTicks;
    this.#idleWithinTicks = idleWithinTicks;
  }

  note(line: string): void {
    this.#notes.push(line);
  }

  summary(): string {
    // Full receipts are in the call log; the completion keeps the story's end.
    const tail = this.#notes.slice(-14);
    const { count, longest, total } = this.#waits;
    return [
      `${this.#requests} requests; ${count} waited for a reflex to release the body (longest ${longest} ticks, ${total} in all)`,
      ...(this.#notes.length > tail.length ? ["…"] : []),
      ...tail,
    ].join("; ");
  }

  async observe(): Promise<LiveSituation> {
    const output = await this.#context.call("view_status", {});
    const parsed = viewStatusResultSchema.safeParse(output.result);
    if (!parsed.success || parsed.data.status !== "succeeded") throw new Failure(`view_status failed: ${output.summary}`);
    const situation = parsed.data.situation;
    if (!situation.dimension.includes("end") || situation.vitals.health <= 0) {
      throw new Failure(`the player died: ${situation.dimension} at health ${situation.vitals.health}`);
    }
    return situation;
  }

  /**
   * A body request, made once the body is free. A reflex (dragon evasion,
   * breath escape, enderman defence) may own it; the caller waits, observing,
   * up to `idleWithinTicks`, then asks once. A refusal is never re-sent.
   */
  async request(action: string, input: Record<string, unknown>): Promise<ScenarioCall> {
    let waited = 0;
    for (;;) {
      const { activity } = await this.observe();
      if (activity.owner === "idle") break;
      if (waited >= this.#idleWithinTicks) {
        throw new Failure(`the body was still owned (${activity.owner}) after ${waited} ticks; ${action} was never requested`);
      }
      await this.#context.waitForTicks(5);
      waited += 5;
    }
    this.#waits.count += waited > 0 ? 1 : 0;
    this.#waits.longest = Math.max(this.#waits.longest, waited);
    this.#waits.total += waited;
    const output = await this.#context.call(action, input);
    this.#requests++;
    const { result } = output;
    if (result.status === "failed" && "error" in result && result.error.startsWith("[ACTION_BUSY]")) {
      throw new Failure(`${action} was refused as busy right after the body was observed idle: ${output.summary}`);
    }
    return output;
  }

  async checkArrangement(arranged: Fight["arranged"]): Promise<void> {
    const { endFight, nearby, inventory } = await this.observe();
    const dragon = endFight.dragons[0];
    const problems = [
      endFight.crystals.length !== arranged.crystals && `${endFight.crystals.length} crystals, not ${arranged.crystals}`,
      !dragon && "no dragon",
      dragon && arranged.dragonHealth !== undefined && dragon.health !== arranged.dragonHealth &&
        `dragon health ${dragon.health}, not ${arranged.dragonHealth}`,
      dragon && arranged.dragonPhases && !arranged.dragonPhases.some((phase) => phase === dragon.phaseName) &&
        `dragon phase ${dragon.phaseName}, not ${arranged.dragonPhases.join(" or ")}`,
      arranged.clouds !== undefined && endFight.clouds.length < arranged.clouds && `${endFight.clouds.length} breath clouds`,
      ...(arranged.mobs ?? []).filter((name) => !nearby.mobs.some((mob) => mob.name === name)).map((name) => `no ${name}`),
      ...(arranged.damaged ?? []).filter(({ item, damage }) => !inventory.stacks.some(({ name, durability }) =>
        name === item && durability !== null && durability.maximum - durability.remaining === damage))
        .map(({ item, damage }) => `no ${item} at damage ${damage}`),
    ].filter((problem): problem is string => typeof problem === "string");
    if (problems.length > 0) throw new Failure(`the arranged End fight was not observed: ${problems.join(", ")}`);
    this.note(`arranged: ${endFight.crystals.length} crystals, dragon ${dragon!.phaseName} at ${dragon!.health} health`);
  }

  async setPolicy({ changes, reason }: NonNullable<Fight["policy"]>): Promise<void> {
    const status = await this.#context.call("view_status", {});
    const revision = status.survivalPolicy?.revision;
    if (!revision) throw new Failure("view_status reported no survival policy revision");
    const output = await this.request("set_survival_policy", {
      operation: "set", expected_revision: revision, changes, lifetime: { kind: "session" }, reason,
    });
    this.note(`set_survival_policy ${output.result.status}`);
    if (output.result.status !== "succeeded") throw new Failure(`set_survival_policy was refused: ${output.summary}`);
  }

  async clearCrystals(plan: NonNullable<Fight["crystals"]>, home: Position): Promise<void> {
    const { crystals } = (await this.observe()).endFight;
    const unknown = crystals.filter(({ cage }) => cage === "unknown");
    if (unknown.length > 0) throw new Failure(`cage status unknown for crystals ${unknown.map(({ entityId }) => entityId).join(", ")}`);
    for (const [crystal, method] of assignMethods(crystals, plan.plan)) {
      if (plan.resupply) await this.resupply(plan.resupply, home);
      await this.destroy(crystal, method, plan, home);
    }
  }

  async resupply({ block, keep, batch }: NonNullable<NonNullable<Fight["crystals"]>["resupply"]>, home: Position, need = keep): Promise<void> {
    const carried = async () => (await this.observe()).inventory.stacks
      .filter(({ name }) => name === block).reduce((sum, { count }) => sum + count, 0);
    for (let have = await carried(); have < need;) {
      const output = await this.request("collect_block", { block_name: block, count: Math.min(batch, need - have) });
      const now = await carried();
      this.note(`resupply ${block} ${have}→${now}: ${output.result.status}`);
      if (now <= have) throw new Failure(`${block} resupply made no progress: ${output.summary}`);
      have = now;
    }
    const output = await this.request("navigate", { ...home, range: 1, build: true });
    if (output.result.status !== "succeeded") throw new Failure(`the walk back to the start failed: ${output.summary}`);
  }

  /**
   * At most `attempts` requests while the crystal stands. A staircase refused
   * for want of blocks is not asked again until the caller has gathered what
   * the refusal names; without a resupply plan, that refusal ends the fight.
   */
  async destroy(crystal: Crystal, method: Method, plan: NonNullable<Fight["crystals"]>, home: Position): Promise<void> {
    const { attempts, resupply } = plan;
    const at = `${crystal.position.x},${crystal.position.y},${crystal.position.z}`;
    const how = `${method.weapon}${method.weapon === "melee" ? `/${method.approach}` : ""}`;
    for (let attempt = 1; ; attempt++) {
      const standing = (await this.observe()).endFight.crystals.find(({ position }) => distance(position, crystal.position) < 2);
      if (!standing) return;
      if (attempt > attempts) throw new Failure(`the crystal at ${at} still stands after ${attempts} ${how} requests`);
      await this.#context.waitForTicks(this.#gapTicks);
      const output = await this.request("destroy_end_crystal", { entity_id: standing.entityId, ...method });
      const receipt = endCombatSchema.safeParse(output.result).data;
      this.note(`crystal ${at} (${crystal.cage === "present" ? "caged" : "exposed"}) ${how}: ` +
        `${receipt?.combat?.outcome ?? output.result.status}` +
        (receipt?.combat?.crystal?.usedWeapon ? ` by ${receipt.combat.crystal.usedWeapon}` : ""));
      // A supply refusal is answered by gathering what it names, or ends the fight.
      const reason = receipt?.combat?.reason ?? "";
      if (/^\[CRYSTAL_\w+_SHORTFALL\]/u.test(reason)) {
        const needed = /^\[CRYSTAL_STAIRCASE_SHORTFALL\].*?(\d+) (\w+) blocks still needed/u.exec(reason);
        if (!resupply || !needed || needed[2] !== resupply.block) throw new Failure(`the crystal at ${at} was refused: ${reason}`);
        await this.resupply(resupply, home, Number(needed[1]));
      }
    }
  }

  /**
   * Prepare during flight and attack each perch until the dragon is gone. A
   * refused request is not asked again under the conditions that refused it:
   * a preparation refused for a breath cloud waits for that cloud to go, and a
   * failed perch attack waits for the dragon's next flight.
   */
  async perchUntilDead(): Promise<void> {
    let prepared = false;
    for (let perches = 0; ;) {
      const dragon = await this.liveDragon();
      if (!dragon) return;
      await this.#context.waitForTicks(this.#gapTicks);
      if (!prepared) {
        const receipt = this.receipt(await this.request("prepare_dragon_perch", { entity_id: dragon.entityId }));
        const reason = receipt.combat?.reason ?? "";
        const cloud = reason.startsWith("[PERCH_PASSAGE_CLOUDED]") ? /Dragon breath #(\d+)/u.exec(reason) : null;
        if (cloud) {
          await this.cloudGone(Number(cloud[1]));
          continue;
        }
        // Any other refusal leaves the attack to wait for the landing itself.
        prepared = receipt.status === "succeeded" && receipt.combat?.outcome === "perch_ready";
      }
      const receipt = this.receipt(await this.request("attack_dragon_perch", { entity_id: dragon.entityId }));
      if (receipt.status !== "succeeded") {
        prepared = false;
        this.note(`perch attack ${receipt.status}: ${(receipt.combat?.reason ?? receipt.error ?? "").slice(0, 120)}`);
        await this.nextFlight();
        continue;
      }
      perches++;
      this.note(`perch ${perches}: ${receipt.combat?.outcome}, dragon at ${dragon.health} health before it`);
      if (receipt.combat?.outcome === "dragon_died") return this.awaitRemoval();
    }
  }

  async cloudGone(id: number): Promise<void> {
    for (let waited = 0; waited <= 1200; waited += 20) {
      if (!(await this.observe()).endFight.clouds.some((cloud) => cloud.id === id)) {
        this.note(`preparation refused for breath #${id}; asked again ${waited} ticks later, once it had gone`);
        return;
      }
      await this.#context.waitForTicks(20);
    }
    throw new Failure(`breath cloud #${id} stayed for a minute after it refused preparation`);
  }

  /** After a failed perch, the next request waits for the dragon to fly again. */
  async nextFlight(): Promise<void> {
    const grounded = new Set(["landing", "sitting_flaming", "sitting_scanning", "sitting_attacking", "takeoff"]);
    for (let waited = 0; waited <= 2400; waited += 20) {
      const dragon = (await this.observe()).endFight.dragons[0];
      if (!dragon || !grounded.has(dragon.phaseName ?? "")) return;
      await this.#context.waitForTicks(20);
    }
    throw new Failure("the dragon stayed on the fountain for two minutes after a failed perch attack");
  }

  async shootUntilDead(hitboxMargin: number, home: Position): Promise<void> {
    for (let shots = 1; ; shots++) {
      const dragon = await this.liveDragon();
      if (!dragon) return;
      const output = await this.request("shoot_dragon", { entity_id: dragon.entityId, hitbox_margin: hitboxMargin });
      const receipt = this.receipt(output);
      if (receipt.combat?.outcome === "dragon_died") return this.awaitRemoval();
      if (receipt.combat?.outcome === "weapon_unavailable") throw new Failure(`the bow is unusable after ${shots} requests: ${output.summary}`);
      if (shots % 20 === 0) this.note(`${shots} shot requests; dragon at ${dragon.health} health`);
      // A perched dragon is immune to arrows; the refused shot waits for its next flight.
      if (receipt.combat?.reason?.startsWith("[DRAGON_PERCHED]")) {
        await this.nextFlight();
        continue;
      }
      // Defence can leave the bot under a roof; the caller walks back to open ground.
      if (receipt.combat?.reason?.startsWith("[DRAGON_SHOT_BLOCKED]")) {
        const { position } = await this.observe();
        if (distance(position, { x: home.x + 0.5, y: home.y, z: home.z + 0.5 }) > 2) {
          const moved = await this.request("navigate", { ...home, range: 0, scaffold: false });
          this.note(`shot blocked away from the start; walked back: ${moved.result.status}`);
        }
      }
      await this.#context.waitForTicks(this.#gapTicks);
    }
  }

  async perchOnce(expect: z.output<typeof expectationSchema>): Promise<void> {
    const dragon = await this.liveDragon();
    if (!dragon) throw new Failure("no dragon to wait for");
    const output = await this.request("attack_dragon_perch", { entity_id: dragon.entityId });
    const { matches, detail } = checkExpectation(expect, output);
    this.note(detail);
    if (!matches) throw new Failure("attack_dragon_perch did not meet its expectation");
  }

  async watch({ ticks, every, phases }: NonNullable<Fight["watch"]>): Promise<void> {
    const seen: string[] = [];
    for (let waited = 0; waited < ticks; waited += every) {
      await this.#context.waitForTicks(every);
      const { endFight } = await this.observe();
      for (const { phaseName } of endFight.dragons) if (phaseName && seen.at(-1) !== phaseName) seen.push(phaseName);
    }
    this.note(`dragon phases observed: ${seen.join(" → ")}`);
    if (!phases.some((phase) => seen.includes(phase))) throw new Failure(`the dragon never reached ${phases.join(" or ")}`);
  }

  /** The dragon, unless it is dying, in which case its removal ends the fight. */
  async liveDragon(): Promise<Dragon | undefined> {
    const dragon = (await this.observe()).endFight.dragons[0];
    if (dragon && dragon.phaseName !== "dying" && dragon.health !== 0) return dragon;
    if (dragon) await this.awaitRemoval();
    else this.note("no dragon loaded");
    return undefined;
  }

  /** Native removal follows the death animation; the kill goal needs it gone. */
  async awaitRemoval(): Promise<void> {
    for (let waited = 0; waited <= 1200; waited += 20) {
      if ((await this.observe()).endFight.dragons.length === 0) {
        this.note("dragon died and was removed");
        return;
      }
      await this.#context.waitForTicks(20);
    }
    throw new Failure("the dragon died but stayed loaded for a minute");
  }

  receipt(output: ScenarioCall): z.output<typeof endCombatSchema> {
    if ("kind" in output.result && output.result.kind === "runtime_failure") throw new Failure(output.summary);
    const parsed = endCombatSchema.safeParse(output.result);
    if (!parsed.success) throw new Failure(`unreadable End combat result: ${output.summary}`);
    return parsed.data;
  }
}

/** Methods follow observed cages and heights, never seed-specific coordinates. */
function assignMethods(crystals: readonly Crystal[], plan: NonNullable<Fight["crystals"]>["plan"]): Array<[Crystal, Method]> {
  const byHeight = (a: Crystal, b: Crystal) => a.position.y - b.position.y;
  const caged = crystals.filter(({ cage }) => cage === "present").sort(byHeight);
  const exposed = crystals.filter(({ cage }) => cage !== "present").sort(byHeight);
  const bow: Method = { weapon: "bow", approach: "staircase" };
  const staircase: Method = { weapon: "melee", approach: "staircase" };
  const pillar: Method = { weapon: "melee", approach: "pillar" };
  const assign = (list: Crystal[], methods: (index: number) => Method) =>
    list.map((crystal, index): [Crystal, Method] => [crystal, methods(index)]);
  switch (plan) {
    case "melee":
      return assign([...crystals].sort(byHeight), () => staircase);
    case "mixed":
      return [...assign(exposed, () => bow), ...assign(caged, () => staircase)];
    case "every_method": {
      // The pillars come last: a staircase climbed after them fails today
      // (known-failing/combat/end-crystals-pillar-then-staircase.yaml).
      const pillars = assign(exposed.slice(0, 2), () => pillar);
      return [...assign(caged, (index) => (index === 0 ? bow : staircase)), ...assign(exposed.slice(2), () => bow), ...pillars];
    }
    case "pillar_then_staircase": {
      const lowest = [pillar, pillar, staircase, staircase];
      return [...assign(exposed, (index) => lowest[index] ?? bow), ...assign(caged, (index) => (index === 0 ? bow : staircase))];
    }
  }
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
