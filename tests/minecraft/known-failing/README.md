# Known-failing scenarios

Faithful fixtures for behaviour that fails today, grouped in the same behavior
folders as `../scenarios/`. `bun run scenarios:once` and `scenarios:full` never
discover them; `bun run scenarios:known-failing` runs this folder once.

Each fixture carries `tags: [known-failing, regression]` and a description of
the failure as it was observed. When the behaviour is fixed, move the fixture
into `../scenarios/<category>/` and drop the `known-failing` tag. The folders
sit at the same depth as `scenarios/<category>/`, so template and client paths
work unchanged.
