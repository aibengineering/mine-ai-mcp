import type { NavigationObservation, WorldView } from "../world/world.js";

/** Only a held swimmer's small vertical oscillation in one still-water surface column. */
export function isSurfaceBobbing(start: NavigationObservation, current: NavigationObservation, world: WorldView): boolean {
  if (start.stance !== "swimming" ||
      (current.stance !== "swimming" && current.stance !== "airborne") ||
      start.dimension !== current.dimension) return false;
  // Water contact briefly reads false at the crest of a normal surface bob.
  // Only a search that began swimming can retain that transition.
  const x = Math.floor(start.position.x);
  const z = Math.floor(start.position.z);
  if (Math.floor(current.position.x) !== x || Math.floor(current.position.z) !== z) return false;
  if (Math.hypot(current.position.x - start.position.x, current.position.z - start.position.z) > 0.1) return false;
  // A floating standing body dips just over one block below the surface.
  // Do not extend this to deep swimming, flowing water, falls or shore landings.
  for (let y = Math.floor(start.position.y); y <= Math.floor(start.position.y) + 1; y++) {
    const water = world.blockAt(x, y, z);
    const above = world.blockAt(x, y + 1, z);
    if (water.kind !== "loaded" || water.traits.liquid !== "water" || !water.traits.liquidSource ||
        above.kind !== "loaded" || !above.traits.empty || above.traits.liquid !== null) continue;
    const surface = y + 1;
    if ([start.position.y, current.position.y].every((height) => height >= surface - 1.3 && height < surface)) return true;
  }
  return false;
}
