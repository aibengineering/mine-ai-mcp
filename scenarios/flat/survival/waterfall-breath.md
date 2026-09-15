# Falling-water overhang regression

Run the three fixtures from the repository root:

```sh
bunx --bun mine-labs run scenarios/flat/survival/waterfall-offset-overhang.yaml scenarios/flat/survival/waterfall-centered-control.yaml scenarios/flat/survival/waterfall-low-air-bedrock.yaml --out .mine-labs/waterfall-breath --repeat 1 --jobs 3
```

[The offset fixture](waterfall-offset-overhang.yaml) reproduces EnderSeeker's
2026-09-09 drowning. [The centered control](waterfall-centered-control.yaml)
changes only the horizontal starting position. Both use a 35-block falling-water
column, a neighboring deepslate overhang, ordinary Survival air and damage, and
the production runtime. No action or driver supplies movement, oxygen, damage,
or rescue. The local overhang and fractional position are translated from the
incident; the complete cave and upstream water source were not reconstructed.

[The driver](waterfall-breath.ts) requires observed air loss followed by a full
bar, at least 14 health throughout, and no death. Mine Labs independently requires
40 seconds of survival. That window exceeds ordinary air depletion and lethal
drowning. An earlier escape can pass without waiting for the reflex's current
12-air threshold. Death is retained even if automatic respawn restores health.

Before the fix the offset bot rose to y=-32.8, held jump against the overhang,
and drowned; the centered bot surfaced with 20 health. The repaired control
detects the shoulder obstruction and swims toward the center of the column.
Both now recover air and survive on isolated Java 1.21.4 servers.

The [low-air bedrock fixture](waterfall-low-air-bedrock.yaml) drains native air
to eight points in a separate flooded preparation pocket, then teleports the
empty-handed bot below an undiggable overhang. The production reflex owns all
movement after that setup. The bot must rise into the obstruction's vicinity,
swim clear, and refill its air; digging cannot pass this case.

The incorrect fact was in the center-only roof probe in
[`surface`](../../../src/survival/responses/breath.ts). The replacement
[swimming clearance](../../../src/survival/positioning/swim-escape.ts) checks collision
shapes across the full body width, searches a short clear lateral swim, and
requires water or safe footing at its endpoint. It avoids a blind exit into a
long fall. A stalled lateral attempt is abandoned after one second without
closing distance. Digging remains the fallback when there is no clear swim;
[the sealed-roof regression](drowning-bot-surfaces.yaml) covers that behavior.

`WATERFALL_TICK` records position, air, health, individual movement controls,
owner, active action, center roof, overhang, and digging. Runtime incident JSONL
also records native damage sources and detailed physics in each run's artifacts.
