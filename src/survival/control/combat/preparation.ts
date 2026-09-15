import type { Bot } from "mineflayer";
import { type NavigationRuntime } from "../../../navigation/index.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import type { CombatPerception } from "../../perception/combat/observations.js";
import { positionThreat } from "../../perception/combat/observations.js";
import { type CombatPolicy } from "../../policy/combat/contract.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { positionExposed } from "../../positioning/combat/exposure.js";
import { positionWorld } from "../../positioning/combat/geometry.js";
import { CombatPosition } from "../../positioning/combat/position.js";
import type { Answered } from "../../state/answered.js";
import { aimPoint, shieldAnswersThreats } from "../../weapons/aim.js";
import { selectMeleeLoadout } from "../../weapons/equipment.js";
import { canMeleeTarget, combatItemsForTarget } from "../../weapons/melee.js";
type Entity = Parameters<Bot["attack"]>[0];
export function combatResourceRefusal(
  bot: Bot,
  navigation: NavigationRuntime,
  target: Entity,
  policy: Readonly<CombatPolicy>,
  perception: CombatPerception,
  answered: Answered,
): string | null {
  if (target.name !== "enderman" && target.name !== "blaze") return null;
  const position = new CombatPosition(bot, navigation, target, new Set(), perception, () => policy, answered);
  if (target.name === "blaze") {
    // The selected blaze will be exposed by the approach even if it is hidden
    // now. Other shooters count when their current firing line is exposed.
    const rays = positionWorld(navigation.world);
    const shooters = [
      positionThreat(bot, target),
      ...position
        .threats()
        .filter(
          (threat) =>
            threat.id !== target.id && threat.attack === "projectile" && positionExposed(rays, bot.entity, threat),
        ),
    ];
    const shield = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(bot, target), policy)).shield;
    if (shieldAnswersThreats(bot, shield, shooters)) return null;
    const planned = position.planCover();
    // Missing material is an admission failure. Local geometry belongs to
    // the physical cover approach, which can reach another supported site.
    return planned.kind === "materials_missing" ? planned.reason : null;
  }
  // A deliberate melee hit can provoke the selected quarry from existing
  // protection even when the roof blocks a ray to its eyes.
  if (position.hasHeightProtection() && canMeleeTarget(bot, target)) return null;
  const planned = position.planRoof({
    kind: "provoke",
    targetEye: aimPoint(bot, target),
    eyeHeight: observedEyeHeight(bot.entity),
  });
  return planned.kind === "materials_missing" ? planned.reason : null;
}
