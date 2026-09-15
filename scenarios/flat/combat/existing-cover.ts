import { Vec3 } from "vec3";
import { z } from "zod";
import { engageTarget } from "../../../src/actions/hunt-mob/hunt-mob.ts";
import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Native mixed attacks against existing cover, isolated from construction and loot randomness. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, navigation, log } = context;
  const { passageFires, witness } = z
    .object({
      passageFires: z.number().int().nonnegative().default(0),
      witness: z.enum(["position_cycle", "guarded_kills"]).default("position_cycle"),
    })
    .parse(context.scenario.params ?? {});
  await wearArmor(context);
  const species = new Set(context.scenario.entities?.map((entity) => entity.type));
  const visibleTargets = () => Object.values(bot.entities).filter((entity) => species.has(entity.name ?? ""));
  // Arrangement acknowledgment can precede the client's entity packets.
  // Use this fixture's existing deadline rather than failing before combat starts.
  while (visibleTargets().length < 2) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  const targets = visibleTargets();
  if (targets.length !== 2) throw new Error("Expected the two native mixed attackers.");
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const combat = scenarioCombat1.controller;
  const stopDecisions = combat.onDecision((decision) => log(`MIXED DECISION ${JSON.stringify(decision)}`));
  const killed = new Set<number>();
  let shieldBlocks = 0;
  let minimumHealth = bot.health;
  const statusSchema = z.object({ entityId: z.number(), entityStatus: z.number() });
  const status = (raw: unknown) => {
    const parsed = statusSchema.safeParse(raw);
    if (parsed.success && parsed.data.entityId === bot.entity.id && parsed.data.entityStatus === 29) shieldBlocks++;
  };
  let protectedTicks = 0;
  let fightingTicks = 0;
  let ticks = 0;
  let fireCell: Vec3 | null = null;
  let fireObserved = false;
  let fireExtinguished = false;
  let fireRemovalConfirmed = false;
  let coverRetained = false;
  let firesStarted = 0;
  let firesCleared = 0;
  const dug: Parameters<typeof bot.on<"diggingCompleted">>[1] = (block) => {
    if (fireObserved && fireCell?.equals(block.position)) {
      fireExtinguished = true;
      log(`PASSAGE FIRE extinguished at ${block.position}`);
    }
  };
  const serverBlock = (packet: { location: { x: number; y: number; z: number }; type: number }) => {
    if (!fireCell?.equals(new Vec3(packet.location.x, packet.location.y, packet.location.z))) return;
    // An instant punch can finish between physics samples. Observe ignition
    // from the server update too, rather than requiring a whole burning tick.
    if (bot.registry.blocksByStateId[packet.type]?.name === "fire") fireObserved = true;
    if (fireObserved && packet.type === bot.registry.blocksByName.air!.defaultState) fireRemovalConfirmed = true;
  };
  const dead = (entity: Parameters<typeof bot.attack>[0]) => {
    killed.add(entity.id);
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    const plan = combat.activePosition();
    if (firesStarted < passageFires && firesCleared === firesStarted && plan && combat.canRecover()) {
      // Ignite an already-adopted passage, as a blaze impact would. With
      // doFireTick disabled, only the bot clearing it can satisfy this witness.
      fireCell = plan.entrance.clone();
      firesStarted++;
      fireObserved = false;
      fireExtinguished = false;
      fireRemovalConfirmed = false;
      coverRetained = false;
      bot.chat(`/setblock ${fireCell.x} ${fireCell.y} ${fireCell.z} minecraft:fire`);
    }
    if (fireCell && bot.blockAt(fireCell)?.name === "fire") fireObserved = true;
    if (fireExtinguished && plan?.entrance.equals(fireCell!) && bot.blockAt(fireCell!)?.name === "air")
      coverRetained = true;
    if (firesCleared < firesStarted && fireObserved && fireExtinguished && fireRemovalConfirmed && coverRetained)
      firesCleared++;
    if (plan && combat.canRecover() && bot.entity.position.distanceTo(plan.protected.offset(0.5, 0, 0.5)) < 0.4)
      protectedTicks++;
    if (plan && bot.entity.position.distanceTo(plan.fighting.offset(0.5, 0, 0.5)) < 0.4) fightingTicks++;
    if (++ticks % 20 === 0)
      log(
        `MIXED COVER ${JSON.stringify({
          health: bot.health,
          position: bot.entity.position,
          protectedTicks,
          fightingTicks,
          plan,
          threats: visibleTargets().map((entity) => ({ id: entity.id, name: entity.name, position: entity.position })),
        })}`,
      );
  };
  bot._client.on("entity_status", status);
  bot.on("entityDead", dead);
  bot.on("diggingCompleted", dug);
  bot._client.on("block_change", serverBlock);
  bot.on("physicsTick", tick);
  try {
    for (const target of targets.sort((a, b) => Number(b.name === "skeleton") - Number(a.name === "skeleton"))) {
      if (killed.has(target.id)) continue;
      const result = await engageTarget(bot, combat, target, { signal });
      log(`MIXED RESULT ${JSON.stringify(result)}`);
      if (result.outcome.kind !== "died") return { status: "failed", detail: JSON.stringify(result) };
    }
    const exit = await navigation.navigate({
      movements: createMovements(bot, { allowDigging: false, scaffolding: false }),
      goal: exactBlockGoal(new Vec3(0, -60, -4)),
      signal,
    });
    return {
      status:
        targets.every((target) => killed.has(target.id)) && bot.health > 0 && exit.status === "completed"
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        killed: [...killed],
        shieldBlocks,
        minimumHealth,
        witness,
        health: bot.health,
        protectedTicks,
        fightingTicks,
        fireObserved,
        fireExtinguished,
        fireRemovalConfirmed,
        coverRetained,
        firesStarted,
        firesCleared,
        exit,
      }),
    };
  } finally {
    stopDecisions();
    bot._client.off("entity_status", status);
    bot.off("entityDead", dead);
    bot.off("diggingCompleted", dug);
    bot._client.off("block_change", serverBlock);
    bot.off("physicsTick", tick);
    await combat.stop("scenario finished");
  }
};
