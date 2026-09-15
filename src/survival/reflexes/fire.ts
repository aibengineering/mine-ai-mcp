import type { Bot } from "mineflayer";
import type { WorldView } from "../../navigation/index.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import type { ReflexDriver } from "../control/driver.js";
import { isBurning, isInFire, isInLava } from "../perception/body.js";
import { decideFireResponse, type FireFacts } from "../policy/environment.js";
import { FIRE_ESCAPE_RADIUS, nearbyFireEscape, type FireEscapeReason } from "../positioning/fire-escape.js";
import { escapeFire } from "../responses/fire.js";

/** Fire owns its environmental authority; combat policy cannot prohibit escape. */
export function attachFireReflex(bot: Bot, driver: ReflexDriver, world: WorldView): AsyncDisposable {
  let advancing = false;
  const blockUpdate = (before: ReturnType<Bot["blockAt"]>, after: ReturnType<Bot["blockAt"]>) => {
    if (
      after?.name === "lava" &&
      before?.stateId !== after.stateId &&
      advancingLavaAt(bot, bot.entity.position, after.position)
    )
      advancing = true;
  };
  bot.on("blockUpdate", blockUpdate);
  const registration = driver.register({
    name: "fire_reflex",
    sense: () => {
      advancing &&= advancingLavaAt(bot);
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      const burning = isBurning(bot);
      if (!advancing && !inLava && !inFire && !burning) return null;
      const reason: FireEscapeReason = advancing ? "advancing_lava" : "contact";
      const facts: FireFacts = {
        reason,
        advancing,
        inLava,
        inFire,
        burning,
        escapeAvailable: nearbyFireEscape(bot, world, reason) !== null,
      };
      return { kind: "observed", danger: facts, evidence: { ...facts } };
    },
    decide: decideFireResponse,
    facts: () => {
      const origin = bot.entity.position.floored();
      return {
        capability: "fire",
        response: "escape_fire",
        scope: `cell:${origin}`,
        permissions: () => null,
        facts: () => {
          // This is exactly the primitive's search volume, including floor and head.
          const cells: (number | null)[] = [];
          for (let x = -FIRE_ESCAPE_RADIUS; x <= FIRE_ESCAPE_RADIUS; x++)
            for (let z = -FIRE_ESCAPE_RADIUS; z <= FIRE_ESCAPE_RADIUS; z++)
              for (let y = -2; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
          return {
            cells,
            body: { inLava: isInLava(bot), inFire: isInFire(bot), onGround: bot.entity.onGround },
            blocks: bot.inventory
              .items()
              .filter((item) => bot.registry.blocksByName[item.name])
              .map((item) => ({ name: item.name, count: item.count })),
          };
        },
      };
    },
    act: async (reason, signal) => {
      const healthBefore = bot.health;
      const outcome = await escapeFire(bot, world, signal, reason);
      return {
        kind:
          outcome === "escaped"
            ? ("dry_footing" as const)
            : outcome === "died"
              ? ("bot_died" as const)
              : ("no_escape" as const),
        healthBefore,
        healthAfter: bot.health,
        burning: isBurning(bot),
        inFire: isInFire(bot),
        inLava: isInLava(bot),
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      };
    },
    // Resumable requests re-observe their checkpoint after the old physical
    // execution releases. A successful escape must not abandon their goal.
    continuation: (outcome) =>
      outcome.kind === "dry_footing"
        ? { kind: "resume" }
        : { kind: "return", reason: "Fire escape did not establish safe footing." },
    failure: (outcome) =>
      outcome.kind === "no_escape" ? { kind: "no_escape", why: "No supported local escape was observed." } : null,
    describe: (outcome) => outcome,
  });
  return {
    async [Symbol.asyncDispose]() {
      bot.off("blockUpdate", blockUpdate);
      await registration[Symbol.asyncDispose]();
    },
  };
}
