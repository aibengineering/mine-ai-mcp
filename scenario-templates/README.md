# Reusable scenario arenas

These use Mine Labs' native `template` field. Keep templates outside `scenarios/`
so the picker only discovers runnable scenarios.

From a scenario in `scenarios/flat/combat/`:

```yaml
template: ../../../scenario-templates/arenas/compact.yaml
```

| Template | Walkable block coordinates | Interior size | Current use |
| --- | --- | --- | --- |
| `arenas/compact.yaml` | x: -5..17, z: -7..7 | 23 x 15 | Skeleton crossfire |
| `arenas/large.yaml` | x: -19..19, z: -15..15 | 39 x 31 | Mixed idle fight |
| `arenas/traverse.yaml` | x: -47..47, z: -19..19 | 95 x 39 | Cross-arena creeper management |

All have a sea-lantern floor at y=-61, two diggable dirt layers at y=-62 and
y=-63, a bedrock foundation at y=-64, and six-block-high bedrock walls anchored
through both dirt layers. Spawn players and mobs with their feet at y=-60.
Creeper blasts can damage the lighting and dirt; the bedrock boundary keeps the
arena bounded above and below the surface.

Templates supply only geometry. Scenarios own the world settings, population,
equipment, client, and goals. Template paths resolve relative to the scenario.
Scenario fields replace template fields (including the entire geometry array);
templates cannot inherit another template.
