# Using asynchronous foreground actions

Foreground MCP tools submit work and optionally wait for the first result. This is a breaking
response change: acceptance is not a physical result. Information and control
tools remain direct calls. The awaited library API `runtime.run` remains available
for in-process callers and shares the same body owner.

## Submit, observe, and continue

1. Call the foreground tool with its normal arguments, `rationale`, a unique
   `submission_id`, and optionally `wait_timeout_ms` (integer 0–120000).
   Prefer a bounded initial wait, such as 5000 ms, for ordinary work. Completion
   returns the full `settled` result in this call; timeout returns `pending`
   progress and its action ID. Zero polls immediately. Omitting the field returns
   an `accepted` handle with `actionId`, `action`, and `admittedAt`.
2. If work is still pending, call `wait_for_action` with that `action_id`, a required integer `timeout_ms`
   from 0 through 120000, and `rationale`. Zero reads immediately. Use short waits
   when reassessing work is valuable. The SDK live playtest qualified 100 ms–30 s
   waits; keep waits below the calling client's transport limit.
3. A timeout returns `state: "pending"`, current progress, and `duringWait`
   changes. The bot keeps working. Inspect status or SQL, wait again, or request
   cancellation according to the evidence.
4. Settlement returns `state: "settled"` and `output`.
   `output.action` discriminates the complete action-owned result schema.
   Terminal `partial`, `failed`, and `cancelled` outcomes retain their available
   evidence. A runtime failure explicitly identifies missing domain evidence.
5. A settled initial or subsequent wait automatically records result retrieval. Submit the next
   foreground action with its ordinary arguments and retry key. No receipt or
   acknowledgement is required. Before retrieval, a new submission is refused
   with `RESULT_NOT_RETRIEVED`, the preceding action ID, and instructions to wait.

For example, submit `navigate`:

```json
{
  "x": 60, "y": 64, "z": 10,
  "submission_id": "walk-to-storage-1",
  "wait_timeout_ms": 5000,
  "rationale": "Walk to the observed storage chest.",
  "response_format": "json"
}
```

If the initial wait returns pending, call `wait_for_action` using its action ID:

```json
{
  "action_id": "<returned actionId>",
  "timeout_ms": 2000,
  "rationale": "Check whether the trip is still making useful progress.",
  "response_format": "json"
}
```

The initial timeout is invocation metadata, not an execution deadline or part of
submission identity. Retrying the same submission with a different timeout waits
on the original action. Invalid timeouts are rejected before admission. Aborting
the initial wait after admission leaves execution running. Refused submissions
return immediately. Each foreground tool publishes only its own typed final output;
`wait_for_action` publishes the union across foreground actions.

A pending wait never means terminal partial completion. Repeated waits after
settlement return the same output, including after successor admission. Markdown includes the existing action result formatter,
final progress and action ID. JSON exposes a generated union of the
registered actions' full output schemas.

Markdown is the default for model use. Pending waits, final progress, and
foreground status show labelled time, distance, observation coverage, and
action-specific evidence instead of embedded JSON. Structure objectives summarize
cell count, materials, and bounds rather than repeating the entire block list;
the complete request remains in JSON and durable execution history. Wait-local changes retain
their signs, so losing previously gained items remains visible. Refusals and
cancellation replies explain the outcome and identify the relevant action.

Pending waits also show current vitals, active survival responses, and actionable
survival warnings. Health and hunger changes between wait entry and return are
labelled as net changes: healing can offset damage, so these are not total damage
counters. JSON retains these as `survival` and `vitalsDuringWait`.

All async replies use the same Markdown notification section as ordinary actions:
an unread count, up to three previews, and the hint to use `read_recent_events`.
Completed reflex previews identify interrupted work, observed health/hunger changes,
and food eaten where recorded. They allow up to 200 characters per reflex preview;
internal decisions and phase changes stay in diagnostic traces. Notifications are
unread history, not exclusively events from this wait. Previews never advance the
event cursor, and current survival is separate from a retained final result.

## Cancellation and reconnection

`cancel_foreground_action` requires `action_id` and `reason`. It requests that
specific objective stop. A necessary reflex can finish its safe release; the
objective cannot resume afterwards. Wait for the cancelled result before giving
replacement work. Cancelling an old settled ID cannot stop a newer action.

Disconnecting an MCP client, cancelling its wait, or reaching its timeout does
not stop admitted work. Reconnect and read the Foreground action section of
`view_status`. In JSON mode, inspect the `foreground` field alongside `response`
in structured content; Markdown mode carries the formatted report without
duplicate raw progress. Recover a lost submission reply
by repeating the same tool arguments and `submission_id`. It returns the original
identity; changing the action arguments is refused as `SUBMISSION_CONFLICT`.

Only one logical objective can be admitted, including suspension, resumption,
and cleanup. A refusal never queues work. `/health.foreground.active` retains the
objective across information calls; `awaitingResult` identifies an
unread result separately. `/health.recentCalls` lists the last eight protocol
calls newest first, any of which may be a wait or status read. Observers should
use `foreground` for the ongoing objective.

## Interpreting progress and storage

Each request has one shared measurement lifetime across all routes and reflexes.
Elapsed time includes preparation and cleanup; suspended time includes handoff
and resumption. Both freeze at settlement. Travel sums observed movement segments;
reflex distance is the subset under reflex ownership. Displacement measures
straight-line distance from the original start in the same dimension. Movement
includes knockback and is not an estimate of useful work.

Teleports, repositioning, and observation gaps break segments instead of adding
coordinate jumps. `sampledAt` dates the snapshot; `positionSampledAt` and
`positionAgeMs` identify its position observation. `movementCoverage` records
missing segments. A broken progress reader reports `request.observationError`
and null evidence while preserving the physical result.

`request.evidence` contains the action baseline, typed checkpoint, and completion
condition. Inventory achievement can decrease. Attempts and confirmed effects
remain separate. Pending waits compare their own entry/exit snapshots; concurrent
readers never reset another wait's baseline.

`action_executions` stores identities, retry keys, original arguments/rationale,
checkpoints, final outputs, and `resultRetrieved` state. Individual calls
remain in `action_requests` and `action_responses`; an acceptance is never rewritten
as a final result. Admission persists before world effects. Terminal storage
or retrieval-state storage failure returns `storage_failed` with the physical
result and blocks successors. Waiting again retries persistence without rerunning work.

Persistent results survive restart. Unfinished durable rows become explicit
`RUNTIME_INTERRUPTED` failures with stale checkpoint evidence and incomplete
coverage; they are never replayed automatically. Temporary storage lasts only
for its runtime. No results or retry keys are automatically pruned in this version.
See the [design and acceptance criteria](async-actions-design.md).
