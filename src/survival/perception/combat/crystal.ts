import type { CrystalStaircase } from "../../positioning/combat/crystal-staircase.js";
import type { Bot, BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { Facts } from "../../state/answered.js";
import { damageSourceName } from "../../../world/damage-registry.js";

export type CrystalWeapon = "auto" | "bow" | "melee";
export type CrystalApproach = "staircase" | "pillar";
export type CrystalPhase = "selecting" | "approaching" | "aiming" | "observing_blast" | "returning" | "settled";
export type CrystalAbortReason = "stance_unreachable" | "cage_uncleared" | "blast_unsafe" | "dragon_contact";

export interface CrystalMeleeEvidence extends Readonly<Record<string, Facts>> {
  readonly scaffoldPlaced: number;
  readonly scaffoldRecovered: number;
  readonly cageBlocksDug: number;
  readonly timeToFirstSwingMs: number | null;
  readonly highestFeetY: number;
  readonly swingFromPlannedStance: boolean | null;
  readonly swingDistance: number | null;
  /** The pedestal shielding the whole body, or null when the swing came from the exposed tower top. */
  readonly blastCoverCell: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** Fraction of the server's body-sample rays the blast could reach from the swing stance. */
  readonly blastExposure: number | null;
  /** Pre-swing estimate of the explosion's damage after worn armor, without enchantments. */
  readonly estimatedBlastDamage: number | null;
  readonly explosionHealthLost: number | null;
  /** Back on supported ground within four blocks of where the climb began. */
  readonly returnedToGround: boolean;
  readonly returnTimeMs: number | null;
  readonly abortReason: CrystalAbortReason | null;
}

export interface CrystalEvidence extends Readonly<Record<string, Facts>> {
  readonly weapon: CrystalWeapon;
  readonly approach: CrystalApproach;
  readonly usedWeapon: "bow" | "melee" | null;
  readonly phase: CrystalPhase;
  readonly melee: CrystalMeleeEvidence;
}

/** Receipts belong to the admitted request, including time spent in a reflex. */
export class CrystalObservation implements Disposable {
  destroyed = false;
  attacks = 0;
  meleeReturn: Vec3 | null = null;
  staircase: CrystalStaircase | null = null;
  shot: { flightTicks: number; firstServerAge: number | null; settled: boolean } | null = null;
  phase: CrystalPhase = "selecting";
  usedWeapon: "bow" | "melee" | null = null;
  readonly startedAt = Date.now();
  readonly startY: number;
  highestFeetY: number;
  scaffoldPlaced = 0;
  scaffoldRecovered = 0;
  cageBlocksDug = 0;
  timeToFirstSwingMs: number | null = null;
  swingFromPlannedStance: boolean | null = null;
  swingDistance: number | null = null;
  blastCoverCell: Vec3 | null = null;
  blastExposure: number | null = null;
  estimatedBlastDamage: number | null = null;
  healthBeforeBlast: number | null = null;
  explosionHealthLost: number | null = null;
  returnedToGround = false;
  returnStartedAt: number | null = null;
  returnTimeMs: number | null = null;
  abortReason: CrystalAbortReason | null = null;
  private readonly placedCells = new Map<string, { readonly name: string; readonly position: Vec3; removed: boolean }>();
  private readonly cageCells = new Set<string>();
  private meleeMeasuring = false;
  private explosionObserved = false;
  private pendingCrystalDamage = false;
  private lastHealth: number;
  readonly target: Parameters<Bot["attack"]>[0] | undefined;
  readonly nativePedestalObserved: boolean;
  readonly dimension: string;

  constructor(
    private readonly bot: Bot,
    readonly targetId: number,
    readonly weapon: CrystalWeapon = "auto",
    readonly approach: CrystalApproach = "staircase",
  ) {
    this.target = bot.entities[targetId];
    const pedestal = this.target && bot.blockAt(this.target.position.offset(0, -1, 0));
    this.nativePedestalObserved = pedestal?.name === "bedrock" || pedestal?.name === "obsidian";
    this.dimension = bot.game.dimension;
    this.startY = bot.entity.position.y;
    this.highestFeetY = this.startY;
    this.lastHealth = bot.health;
    bot.on("entityDead", this.died);
    bot.on("time", this.time);
    bot._client.on("explosion", this.explosion);
    bot.on("physicsTick", this.physics);
    bot.on("blockUpdate", this.blockUpdate);
    bot.on("diggingCompleted", this.dug);
    bot.on("blockPlaced" as "blockUpdate", this.blockPlaced);
    bot.on("playerCollect", this.collected);
    bot.on("health", this.health);
    bot._client.on("damage_event", this.damage);
  }

  private physics = () => {
    if (this.meleeMeasuring) this.highestFeetY = Math.max(this.highestFeetY, this.bot.entity.position.y);
  };
  private blockPlaced: BotEvents["blockUpdate"] = (_oldBlock, newBlock) => {
    if (!this.meleeMeasuring) return;
    const key = newBlock.position.toString();
    if (!this.placedCells.has(key)) {
      this.placedCells.set(key, { name: newBlock.name, position: newBlock.position.clone(), removed: false });
      this.scaffoldPlaced++;
    }
  };
  private blockUpdate: BotEvents["blockUpdate"] = (_oldBlock, newBlock) => {
    if (!this.meleeMeasuring || newBlock.boundingBox !== "empty") return;
    const placed = this.placedCells.get(newBlock.position.toString());
    if (placed) placed.removed = true;
  };
  private collected: BotEvents["playerCollect"] = (collector, entity) => {
    if (!this.meleeMeasuring || collector.id !== this.bot.entity.id) return;
    let item;
    try {
      item = entity.getDroppedItem();
    } catch {
      return;
    }
    if (!item) return;
    const recovered = [...this.placedCells.entries()].find(
      ([, placed]) => placed.removed && placed.name === item.name && placed.position.distanceTo(entity.position) <= 2,
    );
    if (recovered) {
      this.placedCells.delete(recovered[0]);
      this.scaffoldRecovered++;
    }
  };
  private dug = (block: NonNullable<ReturnType<Bot["blockAt"]>>) => {
    const key = block.position.toString();
    if (this.meleeMeasuring && this.cageCells.delete(key)) this.cageBlocksDug++;
  };

  private died = (entity: Parameters<Bot["attack"]>[0]) => {
    if (entity === this.target && this.bot.game.dimension === this.dimension) this.destroyed = true;
  };
  private explosion = (packet: unknown) => {
    const parsed = z.object({ x: z.number(), y: z.number(), z: z.number() }).safeParse(packet);
    if (
      parsed.success &&
      this.bot.game.dimension === this.dimension &&
      this.target &&
      (!this.bot.entities[this.targetId] || this.bot.entities[this.targetId] === this.target) &&
      this.target.position.distanceTo(new Vec3(parsed.data.x, parsed.data.y, parsed.data.z)) < 0.1
    ) {
      this.destroyed = true;
      this.explosionObserved = true;
    }
  };
  private damage = (packet: unknown) => {
    const parsed = z.object({ entityId: z.number(), sourceTypeId: z.number(), sourceCauseId: z.number(), sourceDirectId: z.number() }).safeParse(packet);
    if (!parsed.success || parsed.data.entityId !== this.bot.entity.id) return;
    const targetReference = this.targetId + 1;
    const source = damageSourceName(this.bot, parsed.data.sourceTypeId);
    this.pendingCrystalDamage =
      this.meleeMeasuring &&
      (parsed.data.sourceCauseId === targetReference || parsed.data.sourceDirectId === targetReference) &&
      (source === null ||
        source === "minecraft:explosion" ||
        source === "minecraft:player_explosion" ||
        source === "minecraft:bad_respawn_point");
  };
  private health = () => {
    if (this.pendingCrystalDamage && this.explosionObserved && this.bot.health < this.lastHealth)
      this.explosionHealthLost = (this.explosionHealthLost ?? 0) + this.lastHealth - this.bot.health;
    this.pendingCrystalDamage = false;
    this.lastHealth = this.bot.health;
  };
  private time = () => {
    const shot = this.shot;
    if (!shot) return;
    // Client physics can outrun a lagging server. Start from the first server
    // clock receipt AFTER release, then allow the predicted flight and two
    // server ticks for the impact/removal packets. Removal alone is not a kill.
    shot.firstServerAge ??= this.bot.time.age;
    shot.settled = this.bot.time.age - shot.firstServerAge >= shot.flightTicks + 2;
  };

  released(flightTicks: number): void {
    this.attacks++;
    this.shot = { flightTicks, firstServerAge: null, settled: false };
  }

  beginMelee(): void {
    this.usedWeapon = "melee";
    this.meleeMeasuring = true;
    this.phase = "approaching";
    if (this.target) {
      const origin = this.target.position.floored();
      for (let x = -4; x <= 4; x++)
        for (let y = -4; y <= 4; y++)
          for (let z = -4; z <= 4; z++) {
            const block = this.bot.blockAt(origin.offset(x, y, z));
            if (block?.name === "iron_bars") this.cageCells.add(block.position.toString());
          }
    }
  }

  pauseMeleeMeasurement(): void {
    this.meleeMeasuring = false;
  }

  recordSwing(planned: boolean, distance: number, blast: { cover: Vec3 | null; exposure: number; damage: number }): void {
    this.phase = "aiming";
    this.timeToFirstSwingMs ??= Date.now() - this.startedAt;
    this.swingFromPlannedStance = planned;
    this.swingDistance = distance;
    this.blastCoverCell = blast.cover?.floored() ?? null;
    this.blastExposure = Math.round(blast.exposure * 100) / 100;
    this.estimatedBlastDamage = Math.round(blast.damage * 10) / 10;
    this.healthBeforeBlast = this.bot.health;
  }

  beginBlastObservation(): void {
    this.phase = "observing_blast";
  }

  beginReturn(): void {
    this.phase = "returning";
    this.returnStartedAt ??= Date.now();
  }

  finishReturn(completed: boolean): void {
    this.returnedToGround = completed;
    if (this.returnStartedAt !== null) this.returnTimeMs = Date.now() - this.returnStartedAt;
    this.phase = "settled";
    this.pauseMeleeMeasurement();
  }

  fail(reason: CrystalAbortReason): void {
    this.abortReason = reason;
    this.phase = "settled";
    this.pauseMeleeMeasurement();
  }

  meleeEvidence(): CrystalMeleeEvidence {
    return {
      scaffoldPlaced: this.scaffoldPlaced,
      scaffoldRecovered: this.scaffoldRecovered,
      cageBlocksDug: this.cageBlocksDug,
      timeToFirstSwingMs: this.timeToFirstSwingMs,
      highestFeetY: this.highestFeetY,
      swingFromPlannedStance: this.swingFromPlannedStance,
      swingDistance: this.swingDistance,
      blastCoverCell: this.blastCoverCell
        ? { x: this.blastCoverCell.x, y: this.blastCoverCell.y, z: this.blastCoverCell.z }
        : null,
      blastExposure: this.blastExposure,
      estimatedBlastDamage: this.estimatedBlastDamage,
      explosionHealthLost: this.explosionHealthLost,
      returnedToGround: this.returnedToGround,
      returnTimeMs: this.returnTimeMs,
      abortReason: this.abortReason,
    };
  }

  [Symbol.dispose](): void {
    this.bot.off("entityDead", this.died);
    this.bot.off("time", this.time);
    this.bot._client.off("explosion", this.explosion);
    this.bot.off("physicsTick", this.physics);
    this.bot.off("blockUpdate", this.blockUpdate);
    this.bot.off("diggingCompleted", this.dug);
    this.bot.off("blockPlaced" as "blockUpdate", this.blockPlaced);
    this.bot.off("playerCollect", this.collected);
    this.bot.off("health", this.health);
    this.bot._client.off("damage_event", this.damage);
  }
}
