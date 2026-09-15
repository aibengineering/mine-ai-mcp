import path from "node:path";
import { Vec3 } from "vec3";
import { writeIncidentArtifact } from "../../../src/bot-data/incident-log.ts";
import { IncidentRecorder } from "../../../src/diagnostics/incident-recorder.ts";
import { observeCombatPackets } from "../../../src/diagnostics/combat-packets.ts";
import { observeProjectilePackets } from "../../src/projectile-packets.ts";
import { projectileSnapshot } from "../../../src/diagnostics/projectile-snapshot.ts";
import { trackArrowFlights } from "../../../src/survival/perception/combat/arrow-flight.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Crossfire showed a nine-tick ETA immediately before impact. Isolate the
 * packet -> stored entity -> prediction chain without guard/approach handoffs.
 * Native skeleton shots are unmodified. Success means evidence was obtained,
 * not that the predictor is correct or combat has been qualified. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  const directory = path.join(process.env.MINE_LABS_ARTIFACTS_DIR!, bot.username, "incidents");
  const recorder = new IncidentRecorder({ scenario: "arrow-position-freshness", minecraftVersion: bot.version },
    ({ trigger, requestId, contents }) => writeIncidentArtifact(directory, trigger, requestId, contents),
    (reference) => context.log(`ARROW_CAPTURE ${JSON.stringify(reference)}`));
  using _flights = trackArrowFlights(bot);
  using _packets = observeProjectilePackets(bot, recorder);
  using combat = observeCombatPackets(bot, recorder, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags"));
  let shots = 0, blocks = 0;
  const spawned = (entity: typeof bot.entity) => { if (entity.name === "arrow") shots++; };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) blocks++;
  };
  const damage = (packet: unknown) => recorder.record("packet", { direction: "incoming", packet: "damage_event", fields: packet });
  bot.on("entitySpawn", spawned);
  bot._client.on("entity_status", status);
  bot._client.on("damage_event", damage);
  try {
    await bot.equip(bot.inventory.items().find((item) => item.name === "shield")!, "off-hand");
    await bot.lookAt(new Vec3(0.5, -58.38, 12.5), true);
    bot.activateItem(true);
    await bot.waitForTicks(10);
    bot.chat('/summon minecraft:skeleton 0.5 -60 12.5 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}');
    for (let tick = 0; tick < 240; tick++) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
      const atMs = Date.now();
      recorder.record("physics", { tick, position: bot.entity.position, health: bot.health,
        yaw: bot.entity.yaw, shieldTelemetry: combat.snapshot(),
        entities: Object.values(bot.entities).filter((entity) => entity.name === "arrow").map((entity) => ({
          id: entity.id, position: entity.position, velocity: entity.velocity, projectile: projectileSnapshot(bot, entity),
        })),
      }, atMs);
    }
    const capture = await recorder.capture("operator", null);
    context.log(`ARROW_RESULT ${JSON.stringify({ shots, blocks, health: bot.health, capture })}`);
    return { status: shots >= 2 && blocks >= 1 && capture.kind === "completed" && capture.reference.artifact.kind === "written" ? "succeeded" : "failed",
      detail: `Diagnostic evidence: shots ${shots}, blocks ${blocks}, health ${bot.health}; ${JSON.stringify(capture)}` };
  } finally {
    bot.off("entitySpawn", spawned);
    bot._client.off("entity_status", status);
    bot._client.off("damage_event", damage);
    bot.deactivateItem();
  }
};
