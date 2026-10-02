/**
 * StateDb type definitions for DynaTrader.
 *
 * These interfaces define the row shapes for the unified SQLite `state.db`
 * persistence layer, which replaces the previous JSON-file-based persistence
 * (goals.json, jobs.json, etc.).
 *
 * All timestamps are JS milliseconds (stored as INTEGER in SQLite).
 * JSON fields are stored as TEXT and serialized/deserialized at the
 * application layer.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  agent_id: string;
  platform: string;
  platform_user_id: string;
  status: 'active' | 'idle' | 'closed';
  metadata: string; // JSON
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: string | null; // JSON or null
  tool_results: string | null; // JSON or null
  token_count: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  session_id: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'failed' | 'paused';
  claims: string; // JSON array
  evidence: string; // JSON array
  budget: string; // JSON
  completion_policy: string; // JSON
  created_at: number;
  updated_at: number;
  /** Optional for compatibility with pre-v3 goal callers. */
  priority?: string;
  token_budget_remaining?: number;
  time_budget_remaining?: number;
  self_scheduled?: number; // 0 or 1
  continuation_policy?: string; // JSON
  metadata?: string; // JSON
}

// ---------------------------------------------------------------------------
// Goal Step
// ---------------------------------------------------------------------------

export interface GoalStepRow {
  id: string;
  goal_id: string;
  title: string;
  description: string;
  order: number;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';
  depends_on: string; // JSON array of step IDs
  assignable_tools: string | null; // JSON array or null
  budget: string; // JSON
  output: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Cron Job
// ---------------------------------------------------------------------------

export interface CronJobRow {
  id: string;
  name: string;
  prompt: string | null;
  command: string | null;
  schedule_kind: 'once' | 'interval' | 'cron';
  schedule_display: string;
  schedule_interval_ms: number | null;
  schedule_expression: string | null;
  schedule_run_at: number | null;
  skills: string; // JSON array
  deliver: string; // JSON
  enabled: 0 | 1;
  state: 'scheduled' | 'paused' | 'running' | 'completed';
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  repeat_count: number | null;
  completed_runs: number;
  tags: string; // JSON array
  pipeline: string | null;
  approval_status: string | null;
  execution_policy: string | null;
  wake_agent: 0 | 1;
  context_from: string | null;
  allowed_tools: string | null; // JSON array or null
  disallowed_tools: string | null; // JSON array or null
  model_config: string | null; // JSON or null
  agent_id?: string | null; // Agent to execute this job
  subagent?: string | null; // Subagent to spawn for this job
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Cron Job Runtime State
// ---------------------------------------------------------------------------

export interface CronStateRow {
  id: string;
  job_id: string;
  version: number;
  session_id: string | null;
  prompt_fingerprint: string | null;
  summary: string | null;
  last_output: string | null;
  last_trade: string | null; // JSON or null
  trade_history: string | null; // JSON array or null
  last_venue: string | null;
  last_symbol: string | null;
  last_timeframe: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_run_at: number | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export interface TradeRow {
  id: string;
  session_id: string;
  symbol: string;
  side: 'long' | 'short';
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  pnl: number | null;
  pnl_percent: number | null;
  status: 'open' | 'closed' | 'cancelled';
  chain_id: number | null;
  tx_hash: string | null;
  dex: string | null;
  metadata: string; // JSON
  opened_at: number;
  closed_at: number | null;
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface PositionRow {
  id: string;
  session_id: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  avg_entry_price: number;
  current_price: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
  realized_pnl: number;
  status: 'open' | 'closed';
  metadata: string; // JSON
  opened_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Portfolio Snapshot
// ---------------------------------------------------------------------------

export interface PortfolioSnapshotRow {
  id: string;
  session_id: string;
  total_value: number;
  cash_balance: number;
  invested: number;
  unrealized_pnl: number;
  realized_pnl: number;
  positions_count: number;
  snapshot: string; // JSON — full portfolio state
  taken_at: number;
}

// ---------------------------------------------------------------------------
// Price Cache
// ---------------------------------------------------------------------------

export interface PriceCacheRow {
  id: string;
  symbol: string;
  price: number;
  source: string;
  fetched_at: number;
}

// ---------------------------------------------------------------------------
// State Metadata
// ---------------------------------------------------------------------------

export interface StateMetaRow {
  key: string;
  value: string;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Memory (unified from UI memory-store)
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: string;
  type: 'episodic' | 'semantic';
  content: string;
  importance: number;
  session_id: string;
  created_at: number;
  updated_at: number;
  tags: string; // JSON array
  embedding: Buffer | null;
}

export interface MemoryRelationRow {
  memory_id: string;
  related_id: string;
  relation_type: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Conversation Session (agent conversation branching/forking)
// ---------------------------------------------------------------------------

export interface ConversationSessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  status: 'active' | 'closed';
  metadata: string; // JSON
  created_at: number;
  updated_at: number;
  message_count?: number;
}

// ---------------------------------------------------------------------------
// Conversation Message (rich message storage)
// ---------------------------------------------------------------------------

export interface ConversationMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  parts: string; // JSON array of { type, content, ... }
  token_count: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Compaction Record (structured compaction summaries)
// ---------------------------------------------------------------------------

export interface CompactionRecordRow {
  id: string;
  session_id: string | null;
  trigger_type: string;
  tokens_before: number;
  tokens_after: number;
  summary: string; // JSON: { goal, instructions, discoveries, accomplished, relevantFiles }
  created_at: number;
}

// ---------------------------------------------------------------------------
// Task (persistent task queue)
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  type: string;
  priority: number;
  status: string;
  payload: string; // JSON
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  result: string | null; // JSON
  retries: number;
  max_retries: number;
  timeout: number;
  tags: string; // JSON array
}

export type AgentTaskScope = 'session' | 'project';
export type AgentTaskStatus = 'triage' | 'todo' | 'scheduled' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived' | 'in_progress';
export type AgentTaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type AgentTaskBlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient';

/** Persisted checklist/work item shared by the agent and UI surfaces. */
export interface AgentTaskRow {
  id: string;
  scope: AgentTaskScope;
  scope_id: string;
  title: string;
  description: string;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
  tags: string;
  assigned_to: string | null;
  claim_lock: string | null;
  claim_expires: number | null;
  block_kind: AgentTaskBlockKind | null;
  block_recurrence_count: number;
  heartbeat_at: number | null;
  metadata: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
