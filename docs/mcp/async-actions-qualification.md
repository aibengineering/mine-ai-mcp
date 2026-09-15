# Async action qualification

Qualified on 2026-09-12 in `codex/async-actions`, based on spec commit
`d025d89d1f3f4b31bd61ff920affb9263973b84d`. Implementation remains in the
worktree. Minecraft 1.21.4, Bun 1.4.0, Node 24.18.0, and the installed MCP SDK
were used. Every physical run used one isolated server on port 25691.

The original physical runs below used the earlier receipt handshake. The updated
contract removes receipts and releases the gate on a settled wait. Focused service
and MCP tests verify this revision; it has not yet been loaded into the live
playthrough server.

## Protocol and lifecycle evidence

| Contract | Evidence |
| --- | --- |
| Immediate submission, useful work during waits | Real MCP navigation returned an ID; status and SQL succeeded during travel; a 1500 ms wait returned pending with about 5 blocks travelled. |
| One logical objective through reflex handoffs | Runner ownership tests cover admission during takeover, nested reflexes, resumption, and cancellation. Async admission keeps its reservation until retained settlement. |
| Retry without repeating work | Service tests cover duplicate and conflicting retry keys; reconnect tests and final live retry returned the original action ID. |
| Independent, bounded waits | Tests cover timeout, caller abort, concurrent wait baselines, settlement, and removal of abort listeners. Client reconnection does not cancel execution. |
| Targeted cancellation with safe release | Final live navigation was cancelled while suspended by a zombie reflex. Settlement preserved the model reason and hostile interruption; 760 ms of the 822 ms lifetime was suspended. The original route did not resume. Tests also prove stale cancellation cannot stop a successor. |
| Typed final delivery and repeat retrieval | Catalogue pass captured 108 MCP responses, including three deliberately arranged domain failures. Settled output validates against the original action schema. JSON and original Markdown formatting were exercised. Final live reread was deeply identical after successor completion. |
| Automatic result retrieval gate | Updated tests refuse successors before retrieval and admit them after a settled wait without acknowledgement fields. Pending waits, physical ownership, and storage failure retain their independent gates. The original live receipt test is superseded. |
| Shared movement and timing | A multi-route collection travelled 50.412 blocks. Navigation with hostile and hunger interruptions retained one ID, travelled 65.407 blocks, and recorded 2.066 seconds suspended plus reflex travel. Unit tests cover loops, jumps, dimension changes, observation gaps, nested timing, and frozen settlement. |
| Action-specific evidence | Every production foreground action declares a checkpoint schema. The catalogue's settled results had no observation errors. Inventory regression and failing readers are covered independently; reader failure does not discard a successful physical result. |
| Persistence and recovery | Tests cover admission/terminal write failure, no repeated world effects on persistence retry, retained result rehydration, interruption of nonterminal records without replay, and migration of historical call rows. Recovery tests simulate runtime replacement at the storage boundary. |
| Failure attribution without an open submission | Subprocess watchdog tests preserve original request 812 and action ID `background-action-812` after the submission HTTP response has ended. Existing fatal-runtime tests cover pending HTTP failure delivery. |

## Model-operated playthroughs

The first playthrough collected 12 logs across four locations, smelted three iron
ingots, crafted and equipped a shield, navigated through hostile and hunger
interruptions, deposited items into a chest, and built a three-block barrier.
It also reassessed a distant route after a timed wait and cancelled during a
hostile reflex. This pass exposed a cancellation-reason defect which was fixed
and subsequently verified in the final live pass.

The final pass used a small connection-only host so that the production
Minecraft runtime owned the sole navigation runtime. The model equipped armor,
sampled a distant route, cancelled it after reassessment, cancelled another
route during hostile protection, consumed both full results, and acknowledged
a successor that returned to base. Final health and food were both 20, with no
active foreground request and no storage error. Result rereading and submission
deduplication were checked over new MCP client connections. The isolated server
then saved and shut down successfully.

The catalogue pass exercised the remaining action delivery contracts using
arranged physical successes and failures. It verifies the async adapter and
observed domain outputs; it is not a new qualification of every possible
Minecraft environment or every action strategy.

## Commands and local artifacts

Run static checks and regression tests with:

The final source and scenario typechecks and build passed. The final regression
run passed all 1,281 tests across 178 files in 85.23 seconds.

```powershell
bun run typecheck
bun run typecheck:scenarios
bun run build
bun test src scenarios/src
```

Reproduce the tracked catalogue scenario with:

```powershell
bun node_modules/mine-labs/bin/mine-labs.mjs run scenarios/flat/evidence/action-catalog.yaml --jobs 1 --port 25691 --out .mine-labs/async-catalog --isolated
```

Raw artifacts below are local, ignored files under the implementation worktree:

- First playthrough: `.mine-labs/async-playtest/runs/2026-09-12T11-09-10-785Z-t00001-w1-c1-async-actions-live-playtest/results.json` and `.tmp/live-mcp-transcript.jsonl`.
- Catalogue: `.mine-labs/async-catalog/runs/2026-09-12T11-49-58-352Z-t00001-w1-c1-mine-ai-mcp-evidence/results.json`; `.mine-labs/evidence/action-evidence.json` contains full tool schemas and responses.
- Final control: `.mine-labs/async-final-control/runs/2026-09-12T11-59-17-168Z-t00001-w1-c1-async-actions-final-control/results.json` and `.tmp/live2-mcp-transcript.jsonl`.
- Final regression log: `.tmp/unit-tests-final.log`.

## Practical limits observed

Shared JSON Schema references reduced the serialized wait tool from 1,786,584
to 544,223 bytes; the complete catalogue was 936,955 bytes. The real SDK client
accepted and used it. This does not qualify every third-party host's schema or
transport limits. Timed waits from 100 ms through 30 seconds were exercised;
the supported input ceiling is 120 seconds, subject to the client's own timeout.

The runtime emitted default EventEmitter listener-threshold warnings, including
in the single-runtime final pass. These warnings alone do not establish a leak;
they were not suppressed or used as evidence of duplicate movement accounting.
The catalogue process peaked near 1.25 GB RSS. No CPU or memory profiling claim
is made by these functional playtests. The default headless scenario script now
uses two jobs; qualification used one.
