# Events and responses

Mine AI MCP provides two distinct response formats and maintains an
append-only event log with per-bot read cursors.

Foreground tools return acceptance handles, or accept `wait_timeout_ms` to return
pending progress or the original typed `output` in a settled envelope.
`wait_for_action` uses the same pending and settled response shapes.
This replaces awaiting each foreground tool; see [async actions](async-actions.md).
The formatting below describes full outputs and direct information/control calls.

## How do Markdown and JSON responses differ?

Callers choose a response representation using the `response_format` protocol
argument defined in [src/server/mcp.ts](../../src/server/mcp.ts).

```json
{
  "rationale": "Check live situation.",
  "response_format": "json"
}
```

### Markdown mode (default)

When `response_format` is `"markdown"` or omitted, the server returns human-readable
text in `content[0].text`:

- Tool name, execution status, and duration in milliseconds.
- Any reflex interruptions and resumptions that occurred during the run.
- Action-specific Markdown formatting detailing physical evidence or observed stops.
- Health and hunger, plus relevant survival interruptions, active responses,
  unresolved dangers, or limitations. Routine air readings and internal request,
  policy, and timing diagnostics are omitted. Missing air is warned about when
  the bot is in water, rather than making an ordinary land action look unsafe.
- A notifications section if unread events are waiting.
- The `structuredContent` payload carries the same text as
  `{ response: { format: "markdown", markdown } }`, so a client that renders
  `structuredContent` whenever it is present shows the report rather than an empty envelope.

### JSON mode

When `response_format` is `"json"`, the server returns structured data without
redundant text:

- `content` is an empty array `[]`.
- For settled waits, `structuredContent.response.data.output` contains the complete validated action envelope;
  direct information/control calls place it at `structuredContent.response.data`:
  action name, duration in milliseconds, interruptions, and typed result evidence.
  When supplied by the runtime, the full survival snapshot (including air, water
  contact, observation gaps, request evidence, policy, and timestamps) is retained.
- `structuredContent.notifications` carries the structured notification summary.

In both modes, `isError` is `true` for refusal, storage failure, or a terminal
`"failed"` or `"cancelled"` action. Pending timeouts are not errors.
A `"partial"` status indicates that some progress was observed and
leaves `isError` as `false`.

## How does the event stream track game occurrences?

The runtime records notable occurrences to the `events` table in SQLite through
[src/bot-data/event-log.ts](../../src/bot-data/event-log.ts) and
[src/runtime/player-events.ts](../../src/runtime/player-events.ts). Every event
receives an autoincrementing `event_id`, an observing `bot_id`, and a timestamp.

The event log captures these event types:

- `player_message`: Incoming and outgoing public chat and whispers, noting whether
  the message addressed the bot's username.
- `player_death`: Death events containing the dimension and world coordinates of
  the death location, and the server's own account of the cause as the chat
  line reads: "drowned", "was slain by Zombie", "tried to swim in lava".
- `player_dimension_change`: The bot crossing a portal, with the dimensions
  left and entered and where it arrived.
- `hostile_encounter`: Combat reflex engagements detailing the response mode
  (`fight`, `evade`, or `hide`), outcome, health before and after, engaged
  threat IDs, combat styles used, and for a hide how deep it dug, whether it
  capped the hole, whether the bot was already enclosed, and what it ate. The
  outcome `standing_down` is the reflex reporting that it has no response left
  that could help: a hide could not be built where the bot stands, so the body
  stays with the model until the bot moves, the blocks it carries change, or
  its threats do. Nothing is cancelled while that record stands, and the
  reason names the placement the hide was refused.
- `hunger_reflex`: A bite the runtime took without being asked when hunger
  crossed its bar: the food, hunger and saturation before and after, and the
  action it paused to do so.

## How does the cursor advance in read_recent_events?

The tool `read_recent_events` reads unread events from the durable stream.
Its cursor mechanics are implemented in
[src/actions/read-recent-events/read-recent-events.ts](../../src/actions/read-recent-events/read-recent-events.ts):

1. The query reads `read_through_event_id` for the bot from `event_read_state`.
2. It fetches the oldest unread events where `event_id > read_through_event_id`,
   ordered by `event_id ASC` up to the requested `limit` (default 20, maximum 100).
3. Inside the same SQLite transaction, it updates `read_through_event_id` to match
   the highest `event_id` in the returned batch.
4. The result reports the returned events array, the updated `readThroughEventId`,
   and the count of `remainingEventCount` still unread.

Reading an event page atomically consumes it. To drain a queue of events, call
`read_recent_events` repeatedly until `remainingEventCount` reaches 0.

## What information appears in notification summaries?

Every MCP tool response samples unread events using `readNotificationSummary` in
[src/bot-data/event-log.ts](../../src/bot-data/event-log.ts).

Notification policy applies two rules:

- Only incoming player messages and non-message events (such as deaths and
  encounters) trigger notifications. The bot's own outgoing chat echoes are
  recorded to durable history but never generate notifications.
- Inspecting notifications does not advance the read cursor. Only invoking
  `read_recent_events` advances the cursor.

A notification summary provides:

- `unreadCount`: The number of qualifying unread events since the cursor.
- `recentPreview`: Up to three concise event summaries. Completed survival outcomes
  allow 200 characters so interruption and vitals remain visible; other previews
  allow 40 characters. Truncated previews append an ellipsis.
- `hint`: Directs the caller to use `read_recent_events`.

In Markdown mode, summaries appear under a `## Notifications` heading. In JSON
mode, they populate `structuredContent.notifications`. This applies to async
submission, pending waits, final retrieval, and cancellation replies as well.
