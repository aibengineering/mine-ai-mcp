# Skeleton navigation qualification

These fixtures issue one production navigation request with a sword and shield,
starting outside eight-block contact. They require arrival and no damage, with
natural regeneration disabled. The driver records bow draws, inferred head aim,
first shield use, arrow spawns, damage and encounter receipts. First damage saves
an incident immediately and requests cancellation; the reflex can outlive that
request, so cancellation alone does not preserve the first-hit window. Avoiding all fire
can satisfy travel, but does not qualify projectile blocking; inspect the log.

- `navigation-skeleton-first-shot.yaml`: two staggered shooters on one side.
- `navigation-skeleton-crossfire.yaml`: three nearby shooters inside a 23-by-15-block arena with bedrock walls and a sea-lantern floor. The destination is inside the arena at `[14, -60, 0]`; this is the normal picker entry, not a temporary variant.
- `navigation-skeleton-elevated-crossfire.yaml`: ground and elevated shooters.

Run with `bunx --bun mine-labs run scenarios/flat/combat/navigation-skeleton-*.yaml`.

## Observed on 2026-09-11

The original activation check ignored bow draws beyond eight blocks. Aimed bow
draws now bypass the contact and observation radii without bypassing exposure or
neutral-mob permissions. The Enderman head/body intersection is shared unchanged.
A second gap let guarded combat approach yield its heading for incoming blaze
fireballs but not arrows; approach and volley retention now use the shared
shield-projectile detector.

An initial staggered run arrived at health 20: draw tick 3, shield tick 8, first
arrow tick 20. Repetition did **not** establish reliable completion.

The three-run batch after the aiming and projectile fixes, before the cover
affordability correction, is retained locally under
`.mine-labs/skeleton-arrow-handoff/runs/2026-09-11T06-52-45-199Z-*`:

| Fixture | First shield / arrow tick | Outcome |
| --- | --- | --- |
| Staggered | 32 / 39 | Health 20; journey stopped when defensive cover required 13 blocks, with none carried. |
| Crossfire | 6 / 19 | Health 20; same missing-cover-material limitation. |
| Elevated crossfire | 5 / 16 | Health fell to 16 at tick 344 during approach despite sustained shield use; journey cancelled. |

Each run's `client.log`, `results.json` and incident JSONL contain the evidence.
The elevated failure still needs an approach/facing timing diagnosis; a raised
shield alone does not prove that the incoming arrow is covered. These remain
strict failing qualification cases, not evidence that multi-shooter navigation
is solved. The separate live husk/creeper incident has not been reproduced;
native husk category and melee-contact recognition are covered by a unit test.

## Cover affordability correction

Optional cover now checks material feasibility before construction and leaves
ordinary combat available when material is missing, including a shortfall found
during establishment. Zero-block and insufficient-stack controller tests finish
guarded combat instead of returning a building-materials failure.

The follow-up batch under
`.mine-labs/skeleton-cover-fallback/runs/2026-09-11T07-06-04-984Z-*` passed both
staggered navigation (5 observed arrows) and three-skeleton crossfire (19 observed
arrows), with arrival and minimum health 20. These are one run each, not a
reliability estimate. Elevated crossfire was not rerun in this batch.
