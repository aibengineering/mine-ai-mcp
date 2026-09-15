import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { CombatPolicy } from "../../../policy/combat/contract.js";
import { blastBarrierMaterial } from "../../../positioning/combat/blast-barrier.js";
import type { AnsweredScope } from "../../../state/answered.js";
import { occupiedCell } from "../../../../world/placement.js";

/** A rejected placement belongs to its cells and materials, never the quarry. */
export function blastBarrierScope(bot: Bot, cell: Vec3, policy: () => Readonly<CombatPolicy>): AnsweredScope {
  return {
    capability: "combat.blast_barrier", response: "blast_barrier", scope: cell.toString(),
    permissions: () => ({ place: policy().terrain.place, hide: policy().hide }),
    facts: () => ({
      cells: [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .map(([x, y, z]) => bot.blockAt(cell.offset(x!, y!, z!))?.stateId ?? null),
      occupied: occupiedCell(bot, cell) !== null,
      material: blastBarrierMaterial(bot)?.name ?? null,
    }),
  };
}
