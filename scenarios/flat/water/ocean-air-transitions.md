# Sea and underground air-pocket transitions

These are **expected-refusal regressions**. Successful ocean/air-pocket crossings and construction of underwater breathing pockets are deferred. A passing scenario proves that default navigation promptly returns `no_path` and leaves the bot safe; it does not claim that the crossing is supported.

- `ocean-to-air-pocket.yaml`: start at the sea surface, descend a water shaft, break a two-block dirt plug, move sideways into a riser, then move up into a supported air pocket below the seabed. Bedrock prevents alternate entries through its roof or walls.
- `air-pocket-to-ocean.yaml`: start in a sealed dry chamber, excavate its single dirt hatch beneath source water, climb through, and swim to the sea surface. Cobblestone is supplied for the default policy's scaffolding; missing building material is not the intended obstacle.

Both use `ocean-air-transition.ts`, the production runtime including survival arbitration, and one ordinary `navigate` request. Digging and scaffolding keep their default enabled values. There is no flow-policy override, collection request, direct block removal, or special swimming controller.

The driver logs the actual default break-policy verdict for each barrier, navigation/search output, physical position, eye immersion, air, health, and final barrier states. Success requires:

- Every barrier is prohibited specifically because breaking it `opens_into_liquid`.
- The action fails with observed `no_path` search evidence within 10 seconds, without committing a route or reaching the destination. Timeout, cancellation, and unrelated failures do not count as expected refusal.
- The dirt barriers remain intact throughout observation, and health remains 20.
- After the request settles, the bot has at least 20 consecutive ticks with its eyes in air and full air supply. Missing air metadata is accepted only if the bot was never observed submerged. The driver allows up to 120 physics ticks for this recovery.

The YAML goals assert driver completion, health, and intact barriers. The original destination and geometry remain so that future crossing support can be tested against the same problem.

Run both from the repository root:

```powershell
bunx --bun mine-labs run scenarios/flat/water/ocean-to-air-pocket.yaml scenarios/flat/water/air-pocket-to-ocean.yaml --repeat 1 --jobs 2 --port 31500
```

## Original crossing baseline: 11 September 2026

Before converting these to refusal regressions, both failed their arrival contract:

| Case | Navigation result | Physical outcome |
| --- | --- | --- |
| Sea to air pocket | No path; 25 visited nodes, no committed route | Dirt plug intact; brief initial water immersion, minimum air 294/300; back in breathable air; health 20 |
| Air pocket to sea | No path; 6 visited nodes, no committed route | Dirt hatch intact; bot remained in the dry chamber; health 20 |

The default policy returned `prohibited`, cause `opens_into_liquid`, for every dirt barrier in these fixtures. This establishes the flow-opening restriction as an explicit obstacle; it does not prove that overriding that restriction alone would make either route executable. Under-roof escape admission, fluid updates, and the complete air budget still need qualification before implementing these transitions.

Full output is retained in the ignored `reports/ocean-air-transitions-baseline.log` and the corresponding `.mine-labs/runs/` artifacts. No production policy was changed for these baselines or the refusal regressions.

## Refusal verification: 11 September 2026

Both physical scenarios passed (2/2), and `bun run typecheck:scenarios` passed. The sea-to-pocket request returned `no_path` in 1,631 ms, kept both dirt blocks intact and health 20, and recovered from minimum air 294 to 300. The pocket-to-sea request returned `no_path` in 53 ms, kept its hatch intact and health 20, and remained in breathable air. Neither committed a route. Output is retained in the ignored `reports/ocean-air-transitions-refusal.log`.

## Deferred capability

Planning a breathing pocket requires an executable order of placements and breaks, predicted fluid changes, construction and travel time within the air budget, and a verified breathing destination and escape route. A placement penalty alone cannot establish those conditions. This work is deferred until a concrete task needs it.

When implementing it, keep these default-policy refusal regressions and add crossing scenarios for the deliberately enabled capability. Those must require actual destination arrival, underwater travel, observed air replenishment, and no health loss.
