import assert from "node:assert/strict";
import { z } from "zod";
import { Vec3 } from "vec3";
import { huntMobResultSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { declaredEntitiesArranged, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

const point = z.tuple([z.number(), z.number(), z.number()]);
const paramsSchema = z.strictObject({
  mode: z.enum(["bypass_near", "teleport_away", "failed_approach"]),
  primary: point,
  alternative: point,
  teleportTo: point.optional(),
  returnTo: point.optional(),
  expectedReason: z.string().optional(),
});

/**
 * Two server-tagged native Endermen expose selection through native outgoing
 * damage. Scripted teleports only arrange target movement; production owns
 * every route, target decision, provocation and attack.
 */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params);
  assert.ok(await standStill(context));
  await wearArmor(context);
  await declaredEntitiesArranged(context);

  const nearestTo = ([x, y, z]: readonly [number, number, number]) =>
    Object.values(bot.entities)
      .filter((entity) => entity.isValid && entity.name === "enderman")
      .sort(
        (left, right) => left.position.distanceTo(new Vec3(x, y, z)) - right.position.distanceTo(new Vec3(x, y, z)),
      )[0]!;
  const primary = nearestTo(params.primary);
  const alternative = nearestTo(params.alternative);
  assert.ok(primary && alternative && primary.id !== alternative.id, "The two declared Endermen were not independently observed.");

  const runtime = await openRuntime(context, `enderman-reconsideration-${params.mode}`);
  let firstNativeHit: number | null = null;
  let primaryMoved = false;
  let primaryReturned = false;
  const damage = (packet: { entityId: number; sourceCauseId: number; sourceDirectId: number }) => {
    if (
      firstNativeHit === null &&
      (packet.sourceCauseId === bot.entity.id + 1 || packet.sourceDirectId === bot.entity.id + 1) &&
      (packet.entityId === primary.id || packet.entityId === alternative.id)
    ) {
      firstNativeHit = packet.entityId;
      log(`FIRST_NATIVE_TARGET_HIT ${packet.entityId}`);
    }
  };
  const tick = () => {
    const checkpoint = runtime.status().survival.request?.evidence?.checkpoint;
    const selectedTargetId =
      typeof checkpoint === "object" && checkpoint !== null && "selectedTargetId" in checkpoint &&
      typeof checkpoint.selectedTargetId === "number"
        ? checkpoint.selectedTargetId
        : null;
    if (!primaryMoved && selectedTargetId === primary.id && params.teleportTo) {
      bot.chat(`/tp @e[tag=reconsider_primary,limit=1] ${params.teleportTo.join(" ")}`);
      primaryMoved = true;
      log(`PRIMARY_MOVED ${params.teleportTo.join(" ")}`);
    }
    if (primaryMoved && !primaryReturned && selectedTargetId === alternative.id && params.returnTo) {
      bot.chat(`/tp @e[tag=reconsider_primary,limit=1] ${params.returnTo.join(" ")}`);
      bot.chat("/data merge entity @e[tag=reconsider_primary,limit=1] {NoGravity:0b}");
      primaryReturned = true;
      log(`PRIMARY_RETURNED_AFTER_SELECTION ${selectedTargetId} ${params.returnTo.join(" ")}`);
    }
  };
  bot._client.on("damage_event", damage);
  bot.on("physicsTick", tick);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === "collect_mob_drop")!;
    const output = await runtime.run(
      action,
      { mob_name: "enderman", drop_name: "ender_pearl", count: 1, observe_for_ms: 5_000 },
      signal,
    );
    const result = huntMobResultSchema.parse(output.result);
    const reasonObserved =
      params.expectedReason === undefined ||
      result.hunt.targetChanges.some(({ reason }) => reason === params.expectedReason);
    const expectedFirstHit = params.mode === "teleport_away" ? alternative.id : primary.id;
    const passed = firstNativeHit === expectedFirstHit && reasonObserved && bot.health > 0;
    const evidenceFile = await writeScenarioEvidence(context, `${params.mode}.json`, {
      params,
      primaryId: primary.id,
      alternativeId: alternative.id,
      expectedFirstHit,
      firstNativeHit,
      primaryMoved,
      primaryReturned,
      result,
      output,
    });
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        mode: params.mode,
        primaryId: primary.id,
        alternativeId: alternative.id,
        expectedFirstHit,
        firstNativeHit,
        primaryMoved,
        primaryReturned,
        expectedReason: params.expectedReason ?? null,
        reasonObserved,
        targetChanges: result.hunt.targetChanges,
        health: bot.health,
        evidenceFile,
      }),
    };
  } finally {
    bot._client.off("damage_event", damage);
    bot.off("physicsTick", tick);
    await runtime.close();
  }
};
