CREATE TABLE IF NOT EXISTS sql_bot_data_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS notes (
  note_id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,
  note TEXT NOT NULL,
  context TEXT NOT NULL,
  remembered_at TEXT NOT NULL,
  dimension TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  world_age_ticks INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS notes_bot_id_note_id ON notes (bot_id, note_id DESC);

CREATE TABLE IF NOT EXISTS stronghold_throws (
  throw_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  search_id TEXT NOT NULL,
  thrown_at TEXT NOT NULL,
  throw_position_json TEXT NOT NULL CHECK (json_valid(throw_position_json)),
  entity_uuid TEXT,
  start_json TEXT CHECK (start_json IS NULL OR json_valid(start_json)),
  end_json TEXT CHECK (end_json IS NULL OR json_valid(end_json)),
  bearing_degrees REAL CHECK (bearing_degrees IS NULL OR (bearing_degrees >= 0 AND bearing_degrees < 360)),
  observed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'tracking', 'observed', 'incomplete'))
) STRICT;

CREATE INDEX IF NOT EXISTS stronghold_throws_by_search ON stronghold_throws (bot_id, dimension, search_id);

CREATE TABLE IF NOT EXISTS bot_status (
  bot_id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  game_mode TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  chunk_x INTEGER NOT NULL,
  chunk_z INTEGER NOT NULL,
  yaw REAL NOT NULL,
  pitch REAL NOT NULL,
  on_ground INTEGER NOT NULL CHECK (on_ground IN (0, 1)),
  in_water INTEGER NOT NULL CHECK (in_water IN (0, 1)),
  health REAL NOT NULL,
  food INTEGER NOT NULL,
  saturation REAL NOT NULL,
  time_of_day INTEGER NOT NULL CHECK (time_of_day BETWEEN 0 AND 23999),
  is_sleeping INTEGER NOT NULL CHECK (is_sleeping IN (0, 1)),
  is_raining INTEGER NOT NULL CHECK (is_raining IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS bot_inventory (
  bot_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  location TEXT NOT NULL CHECK (location IN ('main', 'hotbar', 'head', 'torso', 'legs', 'feet', 'off-hand')),
  item_name TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  held INTEGER NOT NULL CHECK (held IN (0, 1)),
  PRIMARY KEY (bot_id, slot)
) STRICT;

CREATE TABLE IF NOT EXISTS bot_last_death (
  bot_id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  observed_at TEXT NOT NULL,
  cause TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS bot_tools (
  bot_id TEXT NOT NULL,
  class TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('tool', 'armour')),
  tier TEXT NOT NULL,
  item_name TEXT,
  slot INTEGER,
  durability_left INTEGER,
  maximum_durability INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, class)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX IF NOT EXISTS events_by_bot
  ON events (bot_id, event_id);

CREATE TABLE IF NOT EXISTS event_read_state (
  bot_id TEXT PRIMARY KEY,
  read_through_event_id INTEGER NOT NULL DEFAULT 0
    CHECK (read_through_event_id >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS action_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  action_name TEXT NOT NULL,
  rationale TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json))
) STRICT;

CREATE INDEX IF NOT EXISTS action_requests_by_bot
  ON action_requests (bot_id, request_id);

CREATE TABLE IF NOT EXISTS action_responses (
  request_id INTEGER PRIMARY KEY,
  responded_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'partial', 'failed', 'cancelled', 'accepted', 'refused', 'pending', 'storage_failed', 'cancellation_requested')),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  FOREIGN KEY (request_id)
    REFERENCES action_requests (request_id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS action_executions (
  bot_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY (bot_id, action_id),
  UNIQUE (bot_id, submission_id)
) STRICT;

CREATE TABLE IF NOT EXISTS action_incidents (
  incident_id TEXT PRIMARY KEY,
  request_id INTEGER REFERENCES action_requests (request_id),
  preceding_request_id INTEGER REFERENCES action_requests (request_id),
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json))
) STRICT;

CREATE INDEX IF NOT EXISTS incidents_by_request ON action_incidents (request_id);
CREATE INDEX IF NOT EXISTS incidents_by_preceding_request ON action_incidents (preceding_request_id);

CREATE TABLE IF NOT EXISTS frontier_chunks (
  chunk_key TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  chunk_x INTEGER NOT NULL,
  chunk_z INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  surface_water_fraction REAL NOT NULL CHECK (surface_water_fraction BETWEEN 0.0 AND 1.0),
  is_frontier INTEGER NOT NULL DEFAULT 1 CHECK (is_frontier IN (0, 1)),
  CHECK (chunk_key = dimension || '|' || chunk_x || '|' || chunk_z),
  UNIQUE (dimension, chunk_x, chunk_z)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS frontier_chunk_materials (
  chunk_key TEXT NOT NULL,
  material TEXT NOT NULL,
  PRIMARY KEY (chunk_key, material),
  FOREIGN KEY (chunk_key)
    REFERENCES frontier_chunks (chunk_key)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS frontier_chunk_materials_by_material
  ON frontier_chunk_materials (material);

CREATE TABLE IF NOT EXISTS frontier_chunk_biomes (
  chunk_key TEXT NOT NULL,
  biome TEXT NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count > 0),
  PRIMARY KEY (chunk_key, biome),
  FOREIGN KEY (chunk_key)
    REFERENCES frontier_chunks (chunk_key)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS observed_containers (
  container_key TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  block_x INTEGER NOT NULL,
  block_y INTEGER NOT NULL,
  block_z INTEGER NOT NULL,
  block_name TEXT NOT NULL,
  slot_count INTEGER NOT NULL CHECK (slot_count >= 0),
  contents_json TEXT NOT NULL CHECK (json_valid(contents_json) AND json_type(contents_json) = 'array'),
  observed_by_bot_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK (container_key = dimension || '|' || block_x || '|' || block_y || '|' || block_z),
  UNIQUE (dimension, block_x, block_y, block_z)
) STRICT, WITHOUT ROWID;

DROP VIEW IF EXISTS observed_container_slots;
DROP VIEW IF EXISTS observed_container_items;

CREATE VIEW observed_container_slots AS
SELECT
  c.container_key,
  c.dimension,
  c.block_x,
  c.block_y,
  c.block_z,
  c.block_name,
  CAST(json_extract(item.value, '$.slot') AS INTEGER) AS slot,
  json_extract(item.value, '$.item') AS item_name,
  CAST(json_extract(item.value, '$.count') AS INTEGER) AS item_count,
  c.observed_by_bot_id,
  c.observed_at
FROM observed_containers AS c
JOIN json_each(c.contents_json) AS item
WHERE json_type(item.value, '$.slot') = 'integer';

CREATE VIEW observed_container_items AS
SELECT
  c.container_key,
  c.dimension,
  c.block_x,
  c.block_y,
  c.block_z,
  c.block_name,
  json_extract(item.value, '$.item') AS item_name,
  SUM(CAST(json_extract(item.value, '$.count') AS INTEGER)) AS item_count,
  c.observed_by_bot_id,
  c.observed_at
FROM observed_containers AS c
JOIN json_each(c.contents_json) AS item
GROUP BY
  c.container_key,
  c.dimension,
  c.block_x,
  c.block_y,
  c.block_z,
  c.block_name,
  json_extract(item.value, '$.item'),
  c.observed_by_bot_id,
  c.observed_at;

CREATE INDEX IF NOT EXISTS frontier_chunk_biomes_by_biome
  ON frontier_chunk_biomes (biome);

CREATE VIEW IF NOT EXISTS frontier_map_chunks AS
SELECT
  c.dimension,
  c.chunk_x,
  c.chunk_z,
  c.surface_water_fraction,
  c.is_frontier,
  (
    SELECT b.biome
    FROM frontier_chunk_biomes AS b
    WHERE b.chunk_key = c.chunk_key
    ORDER BY b.sample_count DESC, b.biome
    LIMIT 1
  ) AS dominant_biome,
  (
    SELECT group_concat(biome, ', ')
    FROM (
      SELECT biome
      FROM frontier_chunk_biomes
      WHERE chunk_key = c.chunk_key
      ORDER BY biome
    )
  ) AS biomes,
  (
    SELECT group_concat(material, ', ')
    FROM (
      SELECT material
      FROM frontier_chunk_materials
      WHERE chunk_key = c.chunk_key
      ORDER BY material
    )
  ) AS materials
FROM frontier_chunks AS c;

DROP VIEW IF EXISTS frontier_navigation;
CREATE VIEW frontier_navigation AS
SELECT
  s.bot_id,
  c.dimension,
  c.chunk_x,
  c.chunk_z,
  c.dominant_biome,
  c.surface_water_fraction,
  c.is_frontier,
  round(sqrt(pow((c.chunk_x * 16 + 8) - s.x, 2) + pow((c.chunk_z * 16 + 8) - s.z, 2)), 1) AS distance_blocks,
  round(mod(mod(degrees(atan2((c.chunk_x * 16 + 8) - s.x, -((c.chunk_z * 16 + 8) - s.z))), 360) + 360, 360), 1) AS heading_degrees
FROM frontier_map_chunks AS c
JOIN bot_status AS s ON s.dimension = c.dimension;

CREATE TABLE IF NOT EXISTS data_dictionary (
  database_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  column_name TEXT,
  description TEXT NOT NULL
) STRICT;

-- The dictionary describes the current runtime schema; it is not accumulated
-- bot memory. Rebuild it whenever a persistent database is opened.
DELETE FROM data_dictionary;

INSERT INTO data_dictionary (database_name, table_name, column_name, description) VALUES
  ('main', 'notes', NULL, 'Free-form notes saved by bots in this world. Reads do not consume notes; no automatic expiry.'),
  ('main', 'notes', 'note_id', 'Unique note identifier; larger ids were saved later, regardless of wall-clock changes.'),
  ('main', 'notes', 'bot_id', 'Bot that saved this note.'),
  ('main', 'notes', 'note', 'The remembered fact, lesson, reminder, or other note.'),
  ('main', 'notes', 'context', 'Motivation and context for storing the note: why it matters and what prompted it.'),
  ('main', 'notes', 'remembered_at', 'UTC timestamp when the note was saved.'),
  ('main', 'notes', 'dimension', 'Bot dimension when the note was saved.'),
  ('main', 'notes', 'x', 'Bot feet position X when the note was saved.'),
  ('main', 'notes', 'y', 'Bot feet position Y when the note was saved.'),
  ('main', 'notes', 'z', 'Bot feet position Z when the note was saved.'),
  ('main', 'notes', 'world_age_ticks', 'Latest server-reported world age in game ticks; null before the first time update. Persists across server restarts, excludes stopped-world time, and advances while the world ticks without this bot. Not personal playtime.'),
  ('main', 'stronghold_throws', NULL, 'Durable Eye of Ender measurements, scoped to a named search, bot and dimension in this world. Reused after cancellation or restart.'),
  ('main', 'stronghold_throws', 'throw_id', 'Unique throw attempt identifier, written before using an eye.'),
  ('main', 'stronghold_throws', 'bot_id', 'Bot that attempted this throw.'),
  ('main', 'stronghold_throws', 'dimension', 'Dimension at throw time; stronghold searches require the Overworld.'),
  ('main', 'stronghold_throws', 'search_id', 'Caller-selected durable search name.'),
  ('main', 'stronghold_throws', 'thrown_at', 'UTC timestamp before the item-use request.'),
  ('main', 'stronghold_throws', 'throw_position_json', 'Bot position before item use, as x/y/z JSON; not the eye bearing origin.'),
  ('main', 'stronghold_throws', 'entity_uuid', 'Observed Eye of Ender entity UUID, or null if no matching spawn was observed.'),
  ('main', 'stronghold_throws', 'start_json', 'Eye spawn position as x/y/z JSON; null until observed.'),
  ('main', 'stronghold_throws', 'end_json', 'Latest observed eye position as x/y/z JSON, updated during flight; null until observed.'),
  ('main', 'stronghold_throws', 'bearing_degrees', 'Compass heading from eye start to end: 0 north, 90 east, 180 south, 270 west; null for less than one block horizontal travel.'),
  ('main', 'stronghold_throws', 'observed_at', 'UTC timestamp of the latest flight observation.'),
  ('main', 'stronghold_throws', 'state', 'pending: item use attempted; tracking: flight observed; observed: entity disappearance observed; incomplete: observation ended without disappearance. A row does not alone prove item consumption.'),
  ('main', 'data_dictionary', NULL, 'Combined descriptions of every model-queryable schema, table, view, and column.'),
  ('main', 'data_dictionary', 'database_name', 'SQLite schema containing the described table or view.'),
  ('main', 'data_dictionary', 'table_name', 'Table or view being described.'),
  ('main', 'data_dictionary', 'column_name', 'Column being described, or NULL for the table or view itself.'),
  ('main', 'data_dictionary', 'description', 'Meaning and interpretation of the schema object or column.'),
  ('main', 'sql_bot_data_metadata', NULL, 'Identity of this database; normally not needed for world queries.'),
  ('main', 'sql_bot_data_metadata', 'key', 'Metadata field name.'),
  ('main', 'sql_bot_data_metadata', 'value', 'Metadata field value.'),
  ('main', 'bot_status', NULL, 'Current physical situation, vitals, and position of the bot in the connected world.'),
  ('main', 'bot_status', 'bot_id', 'Unique identifier or username of the bot.'),
  ('main', 'bot_status', 'dimension', 'Mineflayer dimension containing the bot (e.g. minecraft:overworld).'),
  ('main', 'bot_status', 'game_mode', 'Game mode the server applies to the bot (survival, creative, adventure, spectator).'),
  ('main', 'bot_status', 'x', 'Current exact X world coordinate.'),
  ('main', 'bot_status', 'y', 'Current exact Y world coordinate.'),
  ('main', 'bot_status', 'z', 'Current exact Z world coordinate.'),
  ('main', 'bot_status', 'chunk_x', 'Chunk X coordinate containing the bot.'),
  ('main', 'bot_status', 'chunk_z', 'Chunk Z coordinate containing the bot.'),
  ('main', 'bot_status', 'yaw', 'Current horizontal facing angle in radians.'),
  ('main', 'bot_status', 'pitch', 'Current vertical pitch angle in radians.'),
  ('main', 'bot_status', 'on_ground', '1 when the bot stands on a block, 0 while falling, jumping, swimming, or climbing.'),
  ('main', 'bot_status', 'in_water', '1 when the bot is in water, else 0.'),
  ('main', 'bot_status', 'health', 'Current bot health from 0.0 to 20.0.'),
  ('main', 'bot_status', 'food', 'Current food/hunger level from 0 to 20.'),
  ('main', 'bot_status', 'saturation', 'Hidden food saturation; hunger only drops once this reaches 0.'),
  ('main', 'bot_status', 'time_of_day', 'World clock in ticks from 0 (sunrise) to 23999; beds accept the bot from 12542 to 23458.'),
  ('main', 'bot_status', 'is_sleeping', '1 while the bot lies in a bed, else 0.'),
  ('main', 'bot_status', 'is_raining', '1 while it is raining or thundering in the world, else 0.'),
  ('main', 'bot_status', 'updated_at', 'UTC timestamp when this situation record and bot_inventory were refreshed.'),
  ('main', 'bot_last_death', NULL, 'Most recently observed death retained across respawn and reconnect for recovery planning.'),
  ('main', 'bot_last_death', 'bot_id', 'Bot whose most recent death this row records.'),
  ('main', 'bot_last_death', 'dimension', 'Dimension containing the bot when death was observed.'),
  ('main', 'bot_last_death', 'x', 'Exact death X coordinate.'),
  ('main', 'bot_last_death', 'y', 'Exact death Y coordinate.'),
  ('main', 'bot_last_death', 'z', 'Exact death Z coordinate.'),
  ('main', 'bot_last_death', 'observed_at', 'UTC timestamp when death was observed; wall time is not loaded-chunk item age.'),
  ('main', 'bot_last_death', 'cause', 'Server-rendered death cause when available.'),
  ('main', 'bot_tools', NULL, 'Current best carried item for each tool and armour class, including distinct empty and filled bucket capabilities.'),
  ('main', 'bot_tools', 'bot_id', 'Bot whose current equipment snapshot this row belongs to.'),
  ('main', 'bot_tools', 'class', 'Tool or armour class such as pickaxe, helmet, water_bucket, or lava_bucket.'),
  ('main', 'bot_tools', 'category', 'Whether this row describes a tool or armour.'),
  ('main', 'bot_tools', 'tier', 'Material label. Harvest capability is separate: a golden pickaxe has wooden harvest capability despite its speed.'),
  ('main', 'bot_tools', 'item_name', 'Registry item name, or null when none is carried.'),
  ('main', 'bot_tools', 'slot', 'Current player inventory slot, or null when none is carried.'),
  ('main', 'bot_tools', 'durability_left', 'Observed remaining durability, or null when not applicable or unavailable.'),
  ('main', 'bot_tools', 'maximum_durability', 'Maximum durability from the registry/item stack, or null when not applicable.'),
  ('main', 'bot_tools', 'updated_at', 'UTC timestamp shared with the bot status refresh.'),
  ('main', 'bot_inventory', NULL, 'Current carried and worn item stacks, refreshed atomically with bot_status after inventory/window/equipment events and every second while connected. Status tools also refresh on demand. Empty slots are omitted; this is not acquisition history.'),
  ('main', 'bot_inventory', 'bot_id', 'Bot carrying the stack.'),
  ('main', 'bot_inventory', 'slot', 'Player inventory window slot: 5-8 armor, 9-35 main inventory, 36-44 hotbar, 45 off-hand.'),
  ('main', 'bot_inventory', 'location', 'Where the stack sits: main, hotbar, head, torso, legs, feet, or off-hand.'),
  ('main', 'bot_inventory', 'item_name', 'Registry item name, matching knowledge.items.name.'),
  ('main', 'bot_inventory', 'count', 'Items in the stack.'),
  ('main', 'bot_inventory', 'held', '1 for the hotbar stack currently in the bot''s hand, else 0.'),
  ('main', 'events', NULL, 'Durable chronology of model-relevant observations for bots using this data store.'),
  ('main', 'events', 'event_id', 'Monotonic event chronology and per-bot read cursor.'),
  ('main', 'events', 'bot_id', 'Bot that observed and receives this event.'),
  ('main', 'events', 'event_type', 'Discriminant for the typed JSON payload.'),
  ('main', 'events', 'observed_at', 'UTC timestamp when the event was observed.'),
  ('main', 'events', 'summary', 'Concise event-owned sentence used in notification previews.'),
  ('main', 'events', 'payload_json', 'Complete type-specific event payload as valid JSON.'),
  ('main', 'event_read_state', NULL, 'Per-bot read cursor through the durable event chronology.'),
  ('main', 'event_read_state', 'bot_id', 'Bot whose event cursor this row records.'),
  ('main', 'event_read_state', 'read_through_event_id', 'Highest event ID already read by this bot.'),
  ('main', 'event_read_state', 'updated_at', 'UTC timestamp when the cursor last advanced.'),
  ('main', 'action_requests', NULL, 'Append-only accepted MCP action requests, visible before their actions begin.'),
  ('main', 'action_requests', 'request_id', 'Monotonic identifier shared with the eventual action_responses row.'),
  ('main', 'action_requests', 'bot_id', 'Bot that received the action request.'),
  ('main', 'action_requests', 'action_name', 'Published MCP tool name that was called.'),
  ('main', 'action_requests', 'rationale', 'Caller-supplied reason for taking the action.'),
  ('main', 'action_requests', 'requested_at', 'UTC timestamp when the accepted action request began.'),
  ('main', 'action_requests', 'request_json', 'Complete accepted MCP tool arguments as valid JSON, including rationale and response format.'),
  ('main', 'action_incidents', NULL, 'Developer incident references linked to the foreground or preceding request; no gameplay notifications.'),
  ('main', 'action_incidents', 'incident_id', 'Unique capture identifier.'),
  ('main', 'action_incidents', 'request_id', 'Admitted foreground request at capture, if any.'),
  ('main', 'action_incidents', 'preceding_request_id', 'Recently completed request as context, without causal attribution.'),
  ('main', 'action_incidents', 'reference_json', 'Artifact reference or persistence failure. Retention may remove the artifact.'),
  ('main', 'action_responses', NULL, 'Completed MCP action responses; absence for a request means no response has been produced yet.'),
  ('main', 'action_responses', 'request_id', 'Request being completed; each request can have at most one response.'),
  ('main', 'action_responses', 'responded_at', 'UTC timestamp when the MCP tool handler produced its response.'),
  ('main', 'action_responses', 'duration_ms', 'Action-runner duration reported in the response, in milliseconds.'),
  ('main', 'action_responses', 'status', 'Call outcome: accepted, refused, pending, cancellation_requested, storage_failed, or a settled action status.'),
  ('main', 'action_responses', 'response_json', 'Complete MCP response produced for the caller as valid JSON.'),
  ('main', 'action_executions', NULL, 'Durable logical foreground executions. Several submission/wait/control calls can refer to one execution. Reading never acknowledges a result.'),
  ('main', 'action_executions', 'bot_id', 'Bot owning this execution and retry key.'),
  ('main', 'action_executions', 'action_id', 'Stable execution identity used for waiting and cancellation.'),
  ('main', 'action_executions', 'submission_id', 'Caller retry key; repeating it returns this execution without repeating world effects.'),
  ('main', 'action_executions', 'record_json', 'Original request identity, arguments, rationale, admission time, checkpoint, terminal output and resultRetrieved flag. Checkpoints can be stale; terminal null means settlement is not durably recorded.'),
  ('main', 'observed_containers', NULL, 'Last complete occupied-slot layout observed when a bot opened each location-owned storage container.'),
  ('main', 'observed_containers', 'container_key', 'Stable world-relative key formatted as dimension|block_x|block_y|block_z.'),
  ('main', 'observed_containers', 'dimension', 'Mineflayer dimension containing the container.'),
  ('main', 'observed_containers', 'block_x', 'Container block X coordinate.'),
  ('main', 'observed_containers', 'block_y', 'Container block Y coordinate.'),
  ('main', 'observed_containers', 'block_z', 'Container block Z coordinate.'),
  ('main', 'observed_containers', 'block_name', 'Minecraft block name observed at this location.'),
  ('main', 'observed_containers', 'slot_count', 'Number of storage slots exposed by the opened container.'),
  ('main', 'observed_containers', 'contents_json', 'Complete last-observed occupied slots as a JSON array of slot, item, and count objects; omitted slots are empty.'),
  ('main', 'observed_containers', 'observed_by_bot_id', 'Bot that opened the container and supplied this observation.'),
  ('main', 'observed_containers', 'observed_at', 'UTC timestamp when these complete contents were observed.'),
  ('main', 'observed_container_items', NULL, 'One query-friendly total row per item name in the last-observed contents of each container.'),
  ('main', 'observed_container_items', 'container_key', 'Parent observed_containers location key.'),
  ('main', 'observed_container_items', 'dimension', 'Mineflayer dimension containing the container.'),
  ('main', 'observed_container_items', 'block_x', 'Container block X coordinate.'),
  ('main', 'observed_container_items', 'block_y', 'Container block Y coordinate.'),
  ('main', 'observed_container_items', 'block_z', 'Container block Z coordinate.'),
  ('main', 'observed_container_items', 'block_name', 'Minecraft block name observed at this location.'),
  ('main', 'observed_container_items', 'item_name', 'Minecraft registry name of the observed item.'),
  ('main', 'observed_container_items', 'item_count', 'Total last-observed quantity of this item in the container.'),
  ('main', 'observed_container_items', 'observed_by_bot_id', 'Bot that supplied this observation.'),
  ('main', 'observed_container_items', 'observed_at', 'UTC timestamp of this last complete observation.'),
  ('main', 'observed_container_slots', NULL, 'One query-friendly row per occupied slot in the last-observed layout of each container.'),
  ('main', 'observed_container_slots', 'container_key', 'Parent observed_containers location key.'),
  ('main', 'observed_container_slots', 'dimension', 'Mineflayer dimension containing the container.'),
  ('main', 'observed_container_slots', 'block_x', 'Container block X coordinate.'),
  ('main', 'observed_container_slots', 'block_y', 'Container block Y coordinate.'),
  ('main', 'observed_container_slots', 'block_z', 'Container block Z coordinate.'),
  ('main', 'observed_container_slots', 'block_name', 'Minecraft block name observed at this location.'),
  ('main', 'observed_container_slots', 'slot', 'Zero-based slot within the container-owned section of the opened window.'),
  ('main', 'observed_container_slots', 'item_name', 'Minecraft registry name of the stack in this slot.'),
  ('main', 'observed_container_slots', 'item_count', 'Observed stack quantity in this slot.'),
  ('main', 'observed_container_slots', 'observed_by_bot_id', 'Bot that supplied this observation.'),
  ('main', 'observed_container_slots', 'observed_at', 'UTC timestamp of this last complete observation.'),
  ('main', 'frontier_chunks', NULL, 'Complete observations of chunk columns encountered in this world.'),
  ('main', 'frontier_chunks', 'chunk_key', 'Stable world-relative key formatted as dimension|chunk_x|chunk_z.'),
  ('main', 'frontier_chunks', 'dimension', 'Mineflayer dimension containing the chunk.'),
  ('main', 'frontier_chunks', 'chunk_x', 'Chunk X coordinate; block X coordinates 16n through 16n+15.'),
  ('main', 'frontier_chunks', 'chunk_z', 'Chunk Z coordinate; block Z coordinates 16n through 16n+15.'),
  ('main', 'frontier_chunks', 'first_observed_at', 'UTC timestamp when this process first received the loaded chunk.'),
  ('main', 'frontier_chunks', 'scanned_at', 'UTC timestamp when the complete chunk observation was committed.'),
  ('main', 'frontier_chunks', 'surface_water_fraction', 'Fraction from 0.0 to 1.0 of the 256 horizontal cells whose highest non-air block is water or a bubble column.'),
  ('main', 'frontier_chunks', 'is_frontier', '1 when at least one cardinal neighbour is not recorded; otherwise 0.'),
  ('main', 'frontier_chunk_materials', NULL, 'Distinct non-routine block materials whose state IDs occur anywhere in each full vertical chunk palette; ubiquitous terrain and underground ores are excluded.'),
  ('main', 'frontier_chunk_materials', 'chunk_key', 'Parent frontier_chunks join key.'),
  ('main', 'frontier_chunk_materials', 'material', 'Minecraft block name.'),
  ('main', 'frontier_chunk_biomes', NULL, 'Minecraft biomes sampled across each chunk vertical biome palette.'),
  ('main', 'frontier_chunk_biomes', 'chunk_key', 'Parent frontier_chunks join key.'),
  ('main', 'frontier_chunk_biomes', 'biome', 'Minecraft biome name.'),
  ('main', 'frontier_chunk_biomes', 'sample_count', 'Number of 4x4x4 biome samples with this biome across the loaded chunk column.'),
  ('main', 'frontier_map_chunks', NULL, 'One compact map row per observed chunk, derived from the canonical frontier tables.'),
  ('main', 'frontier_map_chunks', 'dimension', 'Mineflayer dimension containing the chunk.'),
  ('main', 'frontier_map_chunks', 'chunk_x', 'Chunk X coordinate.'),
  ('main', 'frontier_map_chunks', 'chunk_z', 'Chunk Z coordinate.'),
  ('main', 'frontier_map_chunks', 'surface_water_fraction', 'Surface-water fraction copied from frontier_chunks.'),
  ('main', 'frontier_map_chunks', 'is_frontier', 'Frontier flag copied from frontier_chunks.'),
  ('main', 'frontier_map_chunks', 'dominant_biome', 'Most frequently sampled vertical biome; alphabetical name breaks ties.'),
  ('main', 'frontier_map_chunks', 'biomes', 'Alphabetical comma-separated biome names sampled in the chunk.'),
  ('main', 'frontier_map_chunks', 'materials', 'Alphabetical comma-separated non-routine block materials observed in the chunk.'),
  ('main', 'frontier_navigation', NULL, 'Derived frontier chunks joined with live bot status, providing distance in blocks and heading in degrees from the bot.'),
  ('main', 'frontier_navigation', 'bot_id', 'Bot whose current position supplies the distance and heading.'),
  ('main', 'frontier_navigation', 'dimension', 'Mineflayer dimension containing the chunk.'),
  ('main', 'frontier_navigation', 'chunk_x', 'Chunk X coordinate.'),
  ('main', 'frontier_navigation', 'chunk_z', 'Chunk Z coordinate.'),
  ('main', 'frontier_navigation', 'dominant_biome', 'Most frequently sampled vertical biome in the chunk.'),
  ('main', 'frontier_navigation', 'surface_water_fraction', 'Fraction of chunk surface covered by water.'),
  ('main', 'frontier_navigation', 'is_frontier', '1 when at least one cardinal neighbour is unobserved; otherwise 0.'),
  ('main', 'frontier_navigation', 'distance_blocks', 'Euclidean distance in blocks from the bot current position to the chunk centre.'),
  ('main', 'frontier_navigation', 'heading_degrees', 'Compass heading in degrees (0 = North, 90 = East, 180 = South, 270 = West) from the bot to the chunk centre.');
