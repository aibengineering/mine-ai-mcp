import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { z } from "zod";

/**
 * Whether the guard is up before the first hit, or only after it lands.
 *
 * The fortress shape that caused this: the bot is hunting a blaze for its rod,
 * and walks into sword-armed wither skeletons on the way to it.
 *
 * Nothing observed them. A wither skeleton has no windup on the wire - no draw,
 * no charge flag, nothing until the damage packet - and it is not the selected
 * target, so `volleyActive`, which reads only the quarry, had nothing to say
 * about it either. The guard triggers all read a projectile or the attacker
 * attribution that `entityHurt` fills in afterwards, so `approach` lowered the
 * shield for the crossing and the first swing landed on an unguarded bot.
 *
 * The quarry is deliberately far away and deliberately pinned. Standing the
 * fight up already in reach raises the guard for its own reasons and the window
 * never opens - two earlier versions of this fixture passed whether the fix was
 * present or not for exactly that reason. The blaze is the errand, not the
 * subject; pinning it keeps a charge from raising the shield for its own sake
 * and leaves the skeletons as the only thing that can hit the bot.
 *
 * Arrival and survival are not the measure. The bot has no armour and no
 * regeneration precisely so that a lost guard shows as damage rather than being
 * absorbed, and every mob keeps its AI because a pinned one never attacks and
 * the attack is the whole subject.
 */
const paramsSchema = z.strictObject({
  /** Physics ticks to observe before giving the engagement up as inconclusive. */
  observeTicks: z.number().optional().default(900),
});

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  await standStill(context);
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  await bot.equip(shield, "off-hand");

  // The blaze is the quarry: this is a rod hunt that met something on the way,
  // and the skeletons that hit the bot are the ones it never selected.
  const target = bot.nearestEntity((entity) => entity.name === "blaze")!;
  using scenarioCombat = new ScenarioCombat(bot, navigation);
  const combat = scenarioCombat.controller;
  const done = new AbortController();

  let ticks = 0;
  let shieldRaisedAt: number | null = null;
  let firstDamageAt: number | null = null;
  let closestAtFirstDamage: number | null = null;
  let shieldBlocks = 0;
  let health = bot.health;

  const packetSchema = z.object({ entityId: z.number(), entityStatus: z.number() });
  // Vanilla announces a blocked hit as entity status twenty-nine. This is the
  // server's own verdict, not an inference from our posture.
  const status = (raw: unknown) => {
    const parsed = packetSchema.safeParse(raw);
    if (parsed.success && parsed.data.entityId === bot.entity.id && parsed.data.entityStatus === 29) shieldBlocks++;
  };
  const closest = () =>
    Object.values(bot.entities)
      .filter((entity) => (entity.name === "wither_skeleton" || entity.name === "blaze") && entity.isValid)
      .reduce((best, entity) => Math.min(best, entity.position.distanceTo(bot.entity.position)), Infinity);

  const tick = () => {
    ticks++;
    // `usingHeldItem` is the off-hand use that a raised shield is made of.
    if (shieldRaisedAt === null && bot.usingHeldItem) shieldRaisedAt = ticks;
    if (firstDamageAt === null && bot.health < health) {
      firstDamageAt = ticks;
      closestAtFirstDamage = closest();
    }
    health = bot.health;
    if (firstDamageAt !== null || ticks >= params.observeTicks) done.abort("first exchange observed");
  };

  bot.on("physicsTick", tick);
  bot._client.on("entity_status", status);
  try {
    const outcome = await combat.engage(target.id, AbortSignal.any([signal, done.signal]), "pursue");
    const detail = JSON.stringify({
      outcome, ticks, shieldRaisedAt, firstDamageAt, closestAtFirstDamage, shieldBlocks, health: bot.health,
    });
    log(detail);
    // Never touched with the guard up is the best outcome and also a pass: the
    // question is only whether the shield preceded the damage.
    // A trial where nothing ever swung at the bot proves nothing either way.
    if (firstDamageAt === null && shieldBlocks === 0)
      return { status: "failed", detail: `no swing ever reached the bot, so nothing was measured; ${detail}` };
    if (firstDamageAt === null) return { status: "succeeded", detail };
    if (shieldRaisedAt === null) return { status: "failed", detail: `first hit taken with no guard ever raised; ${detail}` };
    if (shieldRaisedAt >= firstDamageAt)
      return { status: "failed", detail: `guard raised at ${shieldRaisedAt}, after damage at ${firstDamageAt}; ${detail}` };
    return { status: "succeeded", detail };
  } finally {
    bot.off("physicsTick", tick);
    bot._client.off("entity_status", status);
  }
};
