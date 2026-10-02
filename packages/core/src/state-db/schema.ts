/**
 * SQL schema for DynaTrader state.db.
 *
 * Uses WAL mode, foreign keys, and declarative DDL with CHECK constraints.
 * FTS5 is used for full-text search on messages.
 */

export const SCHEMA_VERSION = 4;

export const SCHEMA = `
-- -----------------------------------------------------------------------
-- Sessions
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  platform        TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('active','idle','closed')),
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- -----------------------------------------------------------------------
-- Messages
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content      TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,
  tool_results TEXT,
  token_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- FTS5 virtual table for full-text search on message content
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='porter'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- -----------------------------------------------------------------------
-- Goals
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  claims            TEXT NOT NULL DEFAULT '[]',
  evidence          TEXT NOT NULL DEFAULT '[]',
  budget            TEXT NOT NULL DEFAULT '{}',
  completion_policy TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal',
  token_budget_remaining  INTEGER NOT NULL DEFAULT 100000,
  time_budget_remaining   INTEGER NOT NULL DEFAULT 3600000,
  self_scheduled    INTEGER NOT NULL DEFAULT 0,
  continuation_policy TEXT NOT NULL DEFAULT '{}',
  metadata          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

-- -----------------------------------------------------------------------
-- Goal Steps
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goal_steps (
  id               TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  "order"          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',
  depends_on       TEXT NOT NULL DEFAULT '[]',
  assignable_tools TEXT,
  budget           TEXT NOT NULL DEFAULT '{}',
  output           TEXT,
  completed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_steps_goal ON goal_steps(goal_id);

-- -----------------------------------------------------------------------
-- Cron Jobs
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL DEFAULT '',
  prompt               TEXT,
  command              TEXT,
  schedule_kind        TEXT NOT NULL CHECK(schedule_kind IN ('once','interval','cron')),
  schedule_display     TEXT NOT NULL DEFAULT '',
  schedule_interval_ms INTEGER,
  schedule_expression  TEXT,
  schedule_run_at      INTEGER,
  skills               TEXT NOT NULL DEFAULT '[]',
  deliver              TEXT NOT NULL DEFAULT '{}',
  enabled              INTEGER NOT NULL DEFAULT 1,
  state                TEXT NOT NULL DEFAULT 'scheduled',
  last_status          TEXT,
  last_error           TEXT,
  repeat_count         INTEGER,
  completed_runs       INTEGER NOT NULL DEFAULT 0,
  tags                 TEXT NOT NULL DEFAULT '[]',
  pipeline             TEXT,
  approval_status      TEXT,
  execution_policy     TEXT,
  wake_agent           INTEGER NOT NULL DEFAULT 0,
  context_from         TEXT,
  allowed_tools        TEXT,
  disallowed_tools     TEXT,
  model_config         TEXT,
  agent_id             TEXT,
  subagent             TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- -----------------------------------------------------------------------
-- Cron Job Runtime States
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_states (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL DEFAULT 1,
  session_id        TEXT,
  prompt_fingerprint TEXT,
  summary           TEXT,
  last_output       TEXT,
  last_trade        TEXT,
  trade_history     TEXT,
  last_venue        TEXT,
  last_symbol       TEXT,
  last_timeframe    TEXT,
  last_status       TEXT,
  last_error        TEXT,
  last_run_at       INTEGER,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_states_job ON cron_states(job_id);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);

-- -----------------------------------------------------------------------
-- Trades
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  symbol      TEXT NOT NULL DEFAULT '',
  side        TEXT NOT NULL CHECK(side IN ('long','short')),
  entry_price REAL NOT NULL DEFAULT 0,
  exit_price  REAL,
  quantity    REAL NOT NULL DEFAULT 0,
  pnl         REAL,
  pnl_percent REAL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
  chain_id    INTEGER,
  tx_hash     TEXT,
  dex         TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  exchange    TEXT NOT NULL DEFAULT '',
  fees        REAL,
  strategy    TEXT,
  rationale   TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- UI compat columns for trades (exchange, strategy, rationale, fees)
-- Added via reconcileColumns in state-db.ts

-- -----------------------------------------------------------------------
-- Trade Outcomes (structured extraction results from compaction)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_outcomes (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  symbol          TEXT NOT NULL DEFAULT '',
  side            TEXT NOT NULL CHECK(side IN ('long','short')),
  entry_price     REAL NOT NULL DEFAULT 0,
  exit_price      REAL,
  quantity        REAL NOT NULL DEFAULT 0,
  pnl             REAL,
  pnl_percent     REAL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
  strategy        TEXT,
  rationale       TEXT,
  risk_reward     REAL,
  hold_duration   INTEGER,
  lessons_learned TEXT NOT NULL DEFAULT '[]',
  confidence      REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  tags            TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_outcomes_session ON trade_outcomes(session_id);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_symbol ON trade_outcomes(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_status ON trade_outcomes(status);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_strategy ON trade_outcomes(strategy);

-- FTS5 virtual table for full-text search on trade outcomes
CREATE VIRTUAL TABLE IF NOT EXISTS trade_outcomes_fts USING fts5(
  symbol,
  strategy,
  rationale,
  lessons_learned,
  content='trade_outcomes',
  content_rowid='rowid',
  tokenize='porter'
);

-- Triggers to keep trade outcomes FTS index in sync
CREATE TRIGGER IF NOT EXISTS trade_outcomes_ai AFTER INSERT ON trade_outcomes BEGIN
  INSERT INTO trade_outcomes_fts(rowid, symbol, strategy, rationale, lessons_learned)
  VALUES (new.rowid, new.symbol, new.strategy, new.rationale, new.lessons_learned);
END;

CREATE TRIGGER IF NOT EXISTS trade_outcomes_ad AFTER DELETE ON trade_outcomes BEGIN
  INSERT INTO trade_outcomes_fts(trade_outcomes_fts, rowid, symbol, strategy, rationale, lessons_learned)
  VALUES('delete', old.rowid, old.symbol, old.strategy, old.rationale, old.lessons_learned);
END;

CREATE TRIGGER IF NOT EXISTS trade_outcomes_au AFTER UPDATE ON trade_outcomes BEGIN
  INSERT INTO trade_outcomes_fts(trade_outcomes_fts, rowid, symbol, strategy, rationale, lessons_learned)
  VALUES('delete', old.rowid, old.symbol, old.strategy, old.rationale, old.lessons_learned);
  INSERT INTO trade_outcomes_fts(rowid, symbol, strategy, rationale, lessons_learned)
  VALUES (new.rowid, new.symbol, new.strategy, new.rationale, new.lessons_learned);
END;

-- -----------------------------------------------------------------------
-- Positions
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  symbol               TEXT NOT NULL DEFAULT '',
  side                 TEXT NOT NULL CHECK(side IN ('long','short')),
  quantity             REAL NOT NULL DEFAULT 0,
  avg_entry_price      REAL NOT NULL DEFAULT 0,
  current_price        REAL NOT NULL DEFAULT 0,
  unrealized_pnl       REAL NOT NULL DEFAULT 0,
  unrealized_pnl_percent REAL NOT NULL DEFAULT 0,
  realized_pnl         REAL NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  metadata             TEXT NOT NULL DEFAULT '{}',
  opened_at            INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_session ON positions(session_id);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- -----------------------------------------------------------------------
-- Portfolio Snapshots
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  total_value     REAL NOT NULL DEFAULT 0,
  cash_balance    REAL NOT NULL DEFAULT 0,
  invested        REAL NOT NULL DEFAULT 0,
  unrealized_pnl  REAL NOT NULL DEFAULT 0,
  realized_pnl    REAL NOT NULL DEFAULT 0,
  positions_count INTEGER NOT NULL DEFAULT 0,
  snapshot        TEXT NOT NULL DEFAULT '{}',
  taken_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_session ON portfolio_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_taken ON portfolio_snapshots(taken_at);

-- -----------------------------------------------------------------------
-- Price Cache
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_cache (
  id         TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL DEFAULT '',
  price      REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'ccxt',
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_cache_symbol ON price_cache(symbol);

-- -----------------------------------------------------------------------
-- Memories (unified from UI memory-store)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK(type IN ('episodic','semantic')),
  content     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  embedding   BLOB
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

-- FTS5 virtual table for full-text search on memory content
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='porter'
);

-- Triggers to keep memory FTS index in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- -----------------------------------------------------------------------
-- Memory Relations
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_relations (
  memory_id     TEXT NOT NULL,
  related_id    TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (memory_id, related_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (related_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------
-- Tasks (persistent task queue)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  error         TEXT,
  result        TEXT,
  retries       INTEGER DEFAULT 0,
  max_retries   INTEGER DEFAULT 3,
  timeout       INTEGER DEFAULT 1800000,
  tags          TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

-- -----------------------------------------------------------------------
-- Agent todo/task state (session and project scoped)
-- Kept separate from the legacy persistent execution queue above.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK(scope IN ('session','project')),
  scope_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('triage','todo','scheduled','ready','running','blocked','review','done','archived','in_progress')),
  priority        TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  tags            TEXT NOT NULL DEFAULT '[]',
  assigned_to     TEXT,
  claim_lock      TEXT,
  claim_expires   INTEGER,
  block_kind      TEXT CHECK(block_kind IN ('dependency','needs_input','capability','transient')),
  block_recurrence_count INTEGER NOT NULL DEFAULT 0,
  heartbeat_at    INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_scope ON agent_tasks(scope, scope_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated ON agent_tasks(updated_at);

CREATE TABLE IF NOT EXISTS agent_task_links (
  source_id       TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id)
);
CREATE TABLE IF NOT EXISTS agent_task_comments (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  author          TEXT NOT NULL DEFAULT 'agent',
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_task_events (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  actor           TEXT NOT NULL DEFAULT 'agent',
  created_at      INTEGER NOT NULL
);

-- -----------------------------------------------------------------------
-- Conversation Sessions (agent conversation branching/forking)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT,
  title           TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_sessions_parent ON conversation_sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_status ON conversation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_updated ON conversation_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_slug ON conversation_sessions(slug);

-- -----------------------------------------------------------------------
-- Conversation Messages (rich message storage)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  parts           TEXT NOT NULL DEFAULT '[]',
  token_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_session ON conversation_messages(session_id, created_at);

-- -----------------------------------------------------------------------
-- Compaction Records (structured compaction summaries)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compaction_records (
  id              TEXT PRIMARY KEY,
  session_id      TEXT,
  trigger_type    TEXT NOT NULL DEFAULT 'auto',
  tokens_before   INTEGER NOT NULL DEFAULT 0,
  tokens_after    INTEGER NOT NULL DEFAULT 0,
  summary         TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compaction_session ON compaction_records(session_id);
CREATE INDEX IF NOT EXISTS idx_compaction_created ON compaction_records(created_at);

-- -----------------------------------------------------------------------
-- State Metadata (for schema versioning, etc.)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`;
