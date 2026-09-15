import type { Bot } from "mineflayer";
type Entity = Bot["entity"];
/** A power-one ghast explosion reaches two blocks from its impact. */
const BLAST_RADIUS = 2;

/** A large fireball on course to hit the body or explode beside its footing. */
export function incomingFireball(bot: Bot, range: number): Entity | undefined {
  return Object.values(bot.entities).find((entity) => {
    if (entity.name !== "fireball" || !entity.isValid) return false;
    const toward = bot.entity.position.offset(0, bot.entity.height / 2, 0).minus(entity.position);
    if (toward.norm() > range) return false;
    const speedSquared = entity.velocity.dot(entity.velocity);
    const closing = toward.dot(entity.velocity);
    if (speedSquared === 0 || closing <= 0) return false;
    const missSquared = toward.dot(toward) - (closing * closing) / speedSquared;
    return missSquared <= BLAST_RADIUS * BLAST_RADIUS;
  });
}
