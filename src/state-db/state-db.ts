/**
 * StateDb — Unified SQLite persistence layer for DynaTrader.
 *
 * Design uses WAL mode, retry jitter, declarative migrations,
 * and full CRUD for all type interfaces.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { SCHEMA, SCHEMA_VERSION } from './schema';
import type {
  SessionRow,
  GoalRow,
  GoalStepRow,
  CronJobRow,
  CronStateRow,
  TradeRow,
  PositionRow,
  PortfolioSnapshotRow,
  PriceCacheRow,
  MemoryRow,
  MemoryRelationRow,
  TaskRow,
  ConversationSessionRow,
  ConversationMessageRow,
  CompactionRecordRow,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default database directory path */
const DEFAULT_DB_DIR = join(homedir(), '.dynatrader');

/** Error codes from SQLite that warrant a retry */
const RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

/** Maximum number of retry attempts for write operations */
const MAX_RETRIES = 15;

/** Base delay for exponential backoff (ms) */
const BASE_DELAY = 20;

/** Backoff multiplier */
const BACKOFF_MULTIPLIER = 1.5;

/** Maximum delay cap (ms) */
const MAX_DELAY = 150;

/** Maximum jitter (ms) */
const MAX_JITTER = 30;

/**
 * Compute the delay for a given retry attempt.
 * delay = min(base * multiplier^attempt, maxDelay) + random(0, jitter)
 */
function computeDelay(attempt: number): number {
  const exponential = BASE_DELAY * Math.pow(BACKOFF_MULTIPLIER, attempt);
  const capped = Math.min(exponential, MAX_DELAY);
  const jitter = Math.random() * MAX_JITTER;
  return Math.floor(capped + jitter);
}

// ---------------------------------------------------------------------------
// StateDb
// ---------------------------------------------------------------------------

export class StateDb {
  readonly #db: Database.Database;
  readonly #dbDir: string;

  constructor(dbPath?: string) {
    // Resolve the database directory
    const dir = resolve(dbPath ?? DEFAULT_DB_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.#dbDir = dir;

    // Open the database
    const fullPath = join(dir, 'state.db');
    this.#db = new Database(fullPath);

    // Configure pragmas
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('busy_timeout = 5000');

    // Initialize schema and migration
    this.initSchema();
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  /** Full path to the state.db file */
  get path(): string {
    return join(this.#dbDir, 'state.db');
  }

  /** Underlying better-sqlite3 Database instance (for tooling) */
  get raw(): Database.Database {
    return this.#db;
  }

  // -----------------------------------------------------------------------
  // Schema initialization & migration
  // -----------------------------------------------------------------------

  /**
   * Initialize the schema: execute DDL, set schema version, reconcile columns.
   */
  initSchema(): void {
    // Execute the full SCHEMA. better-sqlite3's exec() handles multi-statement
    // DDL including compound statements (triggers, FTS5) correctly, unlike
    // naive semicolon splitting which breaks BEGIN...END blocks.
    this.#db.exec(SCHEMA);

    // Set / verify schema version
    const existingVersion = this.#db
      .prepare("SELECT value FROM state_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (!existingVersion) {
      this.#db
        .prepare(
          `INSERT INTO state_meta (key, value, updated_at) VALUES ('schema_version', '${SCHEMA_VERSION}', ?)`,
        )
        .run(Date.now());
    }

    // Reconcile columns for declarative migration
    this.reconcileColumns();
  }

  /**
   * Declarative column reconciliation.
   *
   * Parses SCHEMA with regex, extracts table + column definitions, compares
   * against PRAGMA table_info, and ALTER TABLE ADD COLUMN for any missing
   * columns. Skips FTS5 virtual tables. Silently catches errors for columns
   * that may already exist from prior runs.
   */
  reconcileColumns(): void {
    const tablePattern =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;

    let match: RegExpExecArray | null;
    const schema = SCHEMA;

    while ((match = tablePattern.exec(schema)) !== null) {
      const tableName = match[1]!;

      // Skip FTS5 virtual tables
      if (tableName.endsWith('_fts')) continue;

      // Find the balanced closing paren
      const startIdx = match.index + match[0].length;
      let depth = 1;
      let endIdx = startIdx;
      while (depth > 0 && endIdx < schema.length) {
        const ch = schema[endIdx];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth > 0) endIdx++;
      }

      const columnsBlock = schema.slice(startIdx, endIdx);

      // Split column definitions respecting nested parens
      const columnDefs = splitColumnDefinitions(columnsBlock);

      // Filter out constraint-only lines (PRIMARY KEY, FOREIGN KEY, CHECK, UNIQUE at top level)
      const dataColumnDefs = columnDefs.filter((def) => {
        const upper = def.toUpperCase();
        // Skip lines that are pure constraints (not column definitions)
        if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(upper)) {
          return false;
        }
        return true;
      });

      // Get existing columns from the database
      let existingCols: Array<{ name: string }> = [];
      try {
        existingCols = this.#db
          .prepare(`PRAGMA table_info('${tableName}')`)
          .all() as Array<{ name: string }>;
      } catch {
        // Table may not exist (shouldn't happen, but be safe)
        continue;
      }

      const existingNames = new Set(existingCols.map((c) => c.name));

      // Add missing columns
      for (const def of dataColumnDefs) {
        const colName = extractColumnName(def);
        if (colName && !existingNames.has(colName)) {
          try {
            this.#db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${def}`);
          } catch {
            // Silently ignore — column may already exist or other transient issue
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Retry helper
  // -----------------------------------------------------------------------

  /**
   * Write retry with exponential backoff and jitter.
   *
   * Wraps `fn` in a transaction (created once, reused across retries).
   * Catches SQLITE_BUSY / SQLITE_LOCKED and retries up to MAX_RETRIES
   * times with exponential backoff + jitter.
   *
   * @throws The last error if all retry attempts are exhausted.
   */
  withRetry<T>(fn: () => T): T {
    // Create the transaction ONCE, outside the retry loop.
    // better-sqlite3's transaction() uses BEGIN DEFERRED by default,
    // which in WAL mode allows concurrent readers without blocking.
    const tx = this.#db.transaction(fn);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return tx();
      } catch (err: unknown) {
        lastError = err as Error;
        const code = (err as { code?: string }).code ?? '';

        if (RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
          const delay = computeDelay(attempt);
          // Synchronous busy-wait — the only option for synchronous
          // retry in Node.js (setTimeout is async, Atomics.wait blocks
          // the main thread on Windows in the same way).
          const deadline = Date.now() + delay;
          while (Date.now() < deadline) {
            /* busy-wait */
          }
          continue;
        }

        // Non-retryable error — throw immediately
        throw err;
      }
    }

    // This should never be reached because the loop either returns or throws
    throw lastError ?? new Error('withRetry exhausted all attempts');
  }

  /**
   * Execute a write SQL statement with retry.
   * Shortcut for the common pattern: prepare + run inside withRetry.
   */
  #write(sql: string, params?: unknown[]): void {
    this.withRetry(() => {
      this.#db.prepare(sql).run(...(params ?? []));
    });
  }

  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------

  saveSession(row: SessionRow): void {
    this.#write(
      `INSERT OR REPLACE INTO sessions
       (id, agent_id, platform, platform_user_id, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.agent_id,
        row.platform,
        row.platform_user_id,
        row.status,
        row.metadata,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  getSession(id: string): SessionRow | null {
    const row = this.#db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ?? null;
  }

  listSessions(filters?: { status?: string; platform?: string }): SessionRow[] {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.platform) {
      sql += ' AND platform = ?';
      params.push(filters.platform);
    }

    sql += ' ORDER BY created_at DESC LIMIT 10000';
    return this.#db.prepare(sql).all(...params) as SessionRow[];
  }

  deleteSession(id: string): void {
    this.#write('DELETE FROM sessions WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Goal CRUD
  // -----------------------------------------------------------------------

  saveGoal(row: GoalRow): void {
    this.#write(
      `INSERT INTO goals
       (id, session_id, title, description, status, claims, evidence, budget,
        completion_policy, created_at, updated_at,
        priority, token_budget_remaining, time_budget_remaining,
        self_scheduled, continuation_policy, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         title = excluded.title,
         description = excluded.description,
         status = excluded.status,
         claims = excluded.claims,
         evidence = excluded.evidence,
         budget = excluded.budget,
         completion_policy = excluded.completion_policy,
         updated_at = excluded.updated_at,
         priority = excluded.priority,
         token_budget_remaining = excluded.token_budget_remaining,
         time_budget_remaining = excluded.time_budget_remaining,
         self_scheduled = excluded.self_scheduled,
         continuation_policy = excluded.continuation_policy,
         metadata = excluded.metadata`,
      [
        row.id,
        row.session_id,
        row.title,
        row.description,
        row.status,
        row.claims,
        row.evidence,
        row.budget,
        row.completion_policy,
        row.created_at,
        row.updated_at,
        row.priority ?? 'normal',
        row.token_budget_remaining ?? 0,
        row.time_budget_remaining ?? 0,
        row.self_scheduled ?? 0,
        row.continuation_policy ?? '{}',
        row.metadata ?? '{}',
      ],
    );
  }

  getGoal(id: string): GoalRow | null {
    const row = this.#db
      .prepare('SELECT * FROM goals WHERE id = ?')
      .get(id) as GoalRow | undefined;
    return row ?? null;
  }

  listGoals(sessionId?: string): GoalRow[] {
    if (sessionId) {
      return this.#db
        .prepare('SELECT * FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 10000')
        .all(sessionId) as GoalRow[];
    }
    return this.#db
      .prepare('SELECT * FROM goals ORDER BY created_at DESC LIMIT 10000')
      .all() as GoalRow[];
  }

  deleteGoal(id: string): void {
    this.#write('DELETE FROM goals WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Goal Step CRUD
  // -----------------------------------------------------------------------

  saveGoalStep(row: GoalStepRow): void {
    this.#write(
      `INSERT INTO goal_steps
       (id, goal_id, title, description, "order", status, depends_on,
        assignable_tools, budget, output, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         goal_id = excluded.goal_id,
         title = excluded.title,
         description = excluded.description,
         "order" = excluded."order",
         status = excluded.status,
         depends_on = excluded.depends_on,
         assignable_tools = excluded.assignable_tools,
         budget = excluded.budget,
         output = excluded.output,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
      [
        row.id,
        row.goal_id,
        row.title,
        row.description,
        row.order,
        row.status,
        row.depends_on,
        row.assignable_tools,
        row.budget,
        row.output,
        row.completed_at,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  listGoalSteps(goalId: string): GoalStepRow[] {
    return this.#db
      .prepare(
        'SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY "order" ASC',
      )
      .all(goalId) as GoalStepRow[];
  }

  listAllGoalSteps(): GoalStepRow[] {
    return this.#db
      .prepare('SELECT * FROM goal_steps ORDER BY "order" ASC')
      .all() as GoalStepRow[];
  }

  deleteGoalSteps(goalId: string): void {
    this.#write('DELETE FROM goal_steps WHERE goal_id = ?', [goalId]);
  }

  getGoalStep(id: string): GoalStepRow | null {
    const row = this.#db
      .prepare('SELECT * FROM goal_steps WHERE id = ?')
      .get(id) as GoalStepRow | undefined;
    return row ?? null;
  }

  deleteGoalStep(id: string): void {
    this.#write('DELETE FROM goal_steps WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Cron Job CRUD
  // -----------------------------------------------------------------------

  saveCronJob(row: CronJobRow): void {
    this.#write(
      `INSERT INTO cron_jobs
       (id, name, prompt, command, schedule_kind, schedule_display,
        schedule_interval_ms, schedule_expression, schedule_run_at,
        skills, deliver, enabled, state, last_status, last_error,
        repeat_count, completed_runs, tags, pipeline, approval_status,
        execution_policy, wake_agent, context_from, allowed_tools,
        disallowed_tools, model_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, prompt=excluded.prompt, command=excluded.command,
        schedule_kind=excluded.schedule_kind, schedule_display=excluded.schedule_display,
        schedule_interval_ms=excluded.schedule_interval_ms, schedule_expression=excluded.schedule_expression, schedule_run_at=excluded.schedule_run_at,
        skills=excluded.skills, deliver=excluded.deliver, enabled=excluded.enabled,
        state=excluded.state, last_status=excluded.last_status, last_error=excluded.last_error,
        repeat_count=excluded.repeat_count, completed_runs=excluded.completed_runs,
        tags=excluded.tags, pipeline=excluded.pipeline, approval_status=excluded.approval_status,
        execution_policy=excluded.execution_policy, wake_agent=excluded.wake_agent,
        context_from=excluded.context_from, allowed_tools=excluded.allowed_tools,
        disallowed_tools=excluded.disallowed_tools, model_config=excluded.model_config,
        created_at=excluded.created_at, updated_at=excluded.updated_at`,
      [
        row.id,
        row.name,
        row.prompt,
        row.command,
        row.schedule_kind,
        row.schedule_display,
        row.schedule_interval_ms,
        row.schedule_expression,
        row.schedule_run_at,
        row.skills,
        row.deliver,
        row.enabled,
        row.state,
        row.last_status,
        row.last_error,
        row.repeat_count,
        row.completed_runs,
        row.tags,
        row.pipeline,
        row.approval_status,
        row.execution_policy,
        row.wake_agent,
        row.context_from,
        row.allowed_tools,
        row.disallowed_tools,
        row.model_config,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  getCronJob(id: string): CronJobRow | null {
    const row = this.#db
      .prepare('SELECT * FROM cron_jobs WHERE id = ?')
      .get(id) as CronJobRow | undefined;
    return row ?? null;
  }

  listCronJobs(enabledOnly = false): CronJobRow[] {
    if (enabledOnly) {
      return this.#db
        .prepare('SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY created_at DESC LIMIT 10000')
        .all() as CronJobRow[];
    }
    return this.#db
      .prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC LIMIT 10000')
      .all() as CronJobRow[];
  }

  deleteCronJob(id: string): void {
    this.#write('DELETE FROM cron_jobs WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Cron State CRUD
  // -----------------------------------------------------------------------

  saveCronState(row: CronStateRow): void {
    this.#write(
      `INSERT INTO cron_states
       (id, job_id, version, session_id, prompt_fingerprint, summary,
        last_output, last_trade, trade_history, last_venue, last_symbol,
        last_timeframe, last_status, last_error, last_run_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        job_id=excluded.job_id, version=excluded.version,
        session_id=excluded.session_id, prompt_fingerprint=excluded.prompt_fingerprint,
        summary=excluded.summary, last_output=excluded.last_output,
        last_trade=excluded.last_trade, trade_history=excluded.trade_history,
        last_venue=excluded.last_venue, last_symbol=excluded.last_symbol,
        last_timeframe=excluded.last_timeframe, last_status=excluded.last_status,
        last_error=excluded.last_error, last_run_at=excluded.last_run_at,
        updated_at=excluded.updated_at`,
      [
        row.id,
        row.job_id,
        row.version,
        row.session_id,
        row.prompt_fingerprint,
        row.summary,
        row.last_output,
        row.last_trade,
        row.trade_history,
        row.last_venue,
        row.last_symbol,
        row.last_timeframe,
        row.last_status,
        row.last_error,
        row.last_run_at,
        row.updated_at,
      ],
    );
  }

  getCronState(jobId: string): CronStateRow | null {
    const rows = this.#db
      .prepare('SELECT * FROM cron_states WHERE job_id = ? LIMIT 1')
      .all(jobId) as CronStateRow[];
    return rows[0] ?? null;
  }

  listCronStates(): CronStateRow[] {
    return this.#db
      .prepare('SELECT * FROM cron_states ORDER BY updated_at DESC LIMIT 10000')
      .all() as CronStateRow[];
  }

  deleteCronState(id: string): void {
    this.#write('DELETE FROM cron_states WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Trade CRUD
  // -----------------------------------------------------------------------

  saveTrade(row: TradeRow): void {
    this.#write(
      `INSERT OR REPLACE INTO trades
       (id, session_id, symbol, side, entry_price, exit_price, quantity,
        pnl, pnl_percent, status, chain_id, tx_hash, dex, metadata,
        opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.symbol,
        row.side,
        row.entry_price,
        row.exit_price,
        row.quantity,
        row.pnl,
        row.pnl_percent,
        row.status,
        row.chain_id,
        row.tx_hash,
        row.dex,
        row.metadata,
        row.opened_at,
        row.closed_at,
      ],
    );
  }

  listTrades(filters?: {
    sessionId?: string;
    symbol?: string;
    status?: string;
  }): TradeRow[] {
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(filters.sessionId);
    }
    if (filters?.symbol) {
      sql += ' AND symbol = ?';
      params.push(filters.symbol);
    }
    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }

    sql += ' ORDER BY opened_at DESC LIMIT 10000';
    return this.#db.prepare(sql).all(...params) as TradeRow[];
  }

  // -----------------------------------------------------------------------
  // Position CRUD
  // -----------------------------------------------------------------------

  savePosition(row: PositionRow): void {
    this.#write(
      `INSERT OR REPLACE INTO positions
       (id, session_id, symbol, side, quantity, avg_entry_price,
        current_price, unrealized_pnl, unrealized_pnl_percent,
        realized_pnl, status, metadata, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.symbol,
        row.side,
        row.quantity,
        row.avg_entry_price,
        row.current_price,
        row.unrealized_pnl,
        row.unrealized_pnl_percent,
        row.realized_pnl,
        row.status,
        row.metadata,
        row.opened_at,
        row.updated_at,
      ],
    );
  }

  listPositions(filters?: {
    sessionId?: string;
    symbol?: string;
    status?: string;
  }): PositionRow[] {
    let sql = 'SELECT * FROM positions WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(filters.sessionId);
    }
    if (filters?.symbol) {
      sql += ' AND symbol = ?';
      params.push(filters.symbol);
    }
    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }

    sql += ' ORDER BY opened_at DESC LIMIT 10000';
    return this.#db.prepare(sql).all(...params) as PositionRow[];
  }

  // -----------------------------------------------------------------------
  // Portfolio Snapshot CRUD
  // -----------------------------------------------------------------------

  savePortfolioSnapshot(row: PortfolioSnapshotRow): void {
    this.#write(
      `INSERT OR REPLACE INTO portfolio_snapshots
       (id, session_id, total_value, cash_balance, invested, unrealized_pnl,
        realized_pnl, positions_count, snapshot, taken_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.total_value,
        row.cash_balance,
        row.invested,
        row.unrealized_pnl,
        row.realized_pnl,
        row.positions_count,
        row.snapshot,
        row.taken_at,
      ],
    );
  }

  listPortfolioSnapshots(
    sessionId?: string,
    limit = 20,
  ): PortfolioSnapshotRow[] {
    if (sessionId) {
      return this.#db
        .prepare(
          'SELECT * FROM portfolio_snapshots WHERE session_id = ? ORDER BY taken_at DESC LIMIT ?',
        )
        .all(sessionId, limit) as PortfolioSnapshotRow[];
    }
    return this.#db
      .prepare(
        'SELECT * FROM portfolio_snapshots ORDER BY taken_at DESC LIMIT ?',
      )
      .all(limit) as PortfolioSnapshotRow[];
  }

  // -----------------------------------------------------------------------
  // Price Cache
  // -----------------------------------------------------------------------

  savePrice(symbol: string, price: number, source = 'ccxt'): void {
    const id = `${symbol}-${Date.now()}`;
    this.#write(
      `INSERT OR REPLACE INTO price_cache
       (id, symbol, price, source, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, symbol, price, source, Date.now()],
    );
  }

  getCachedPrice(
    symbol: string,
    maxAgeMs = 60000,
  ): PriceCacheRow | null {
    const cutoff = Date.now() - maxAgeMs;
    const row = this.#db
      .prepare(
        'SELECT * FROM price_cache WHERE symbol = ? AND fetched_at > ? ORDER BY fetched_at DESC LIMIT 1',
      )
      .get(symbol, cutoff) as PriceCacheRow | undefined;
    return row ?? null;
  }

  // -----------------------------------------------------------------------
  // Memory CRUD (unified from UI memory-store)
  // -----------------------------------------------------------------------

  saveMemory(row: Omit<MemoryRow, 'embedding'>): void {
    this.#write(
      `INSERT INTO memories (id, type, content, importance, session_id, created_at, updated_at, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         importance = excluded.importance,
         updated_at = excluded.updated_at,
         tags = excluded.tags`,
      [
        row.id,
        row.type,
        row.content,
        row.importance,
        row.session_id,
        row.created_at,
        row.updated_at,
        row.tags,
      ],
    );
  }

  getMemory(id: string): MemoryRow | null {
    const row = this.#db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ?? null;
  }

  listMemories(filters?: {
    type?: 'episodic' | 'semantic';
    session_id?: string;
    minImportance?: number;
    tags?: string[];
    start_time?: number;
    end_time?: number;
    limit?: number;
  }): MemoryRow[] {
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.session_id) {
      sql += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.minImportance !== undefined) {
      sql += ' AND importance >= ?';
      params.push(filters.minImportance);
    }
    if (filters?.tags && filters.tags.length > 0) {
      const conditions = filters.tags.map(() => 'tags LIKE ?');
      sql += ` AND (${conditions.join(' OR ')})`;
      for (const tag of filters.tags) {
        params.push(`%"${tag}"%`);
      }
    }
    if (filters?.start_time) {
      sql += ' AND created_at >= ?';
      params.push(filters.start_time);
    }
    if (filters?.end_time) {
      sql += ' AND created_at <= ?';
      params.push(filters.end_time);
    }

    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(filters?.limit ?? 50);

    return this.#db.prepare(sql).all(...params) as MemoryRow[];
  }

  searchMemories(query: string, limit = 20): Array<{ id: string; content: string; score: number }> {
    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) return [];

    // Phase 1: Try FTS5 full-text search (porter stemming, ranked)
    try {
      const ftsQuery = words.map((w) => `"${w}"`).join(' OR ');
      const ftsRows = this.#db
        .prepare(
          `SELECT m.id, m.content, m.importance, rank
           FROM memories_fts fts
           JOIN memories m ON m.rowid = fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit * 2) as Array<{
        id: string;
        content: string;
        importance: number;
        rank: number;
      }>;

      if (ftsRows.length > 0) {
        // FTS5 rank is negative (closer to 0 = better), normalize to 0-1
        const maxRank = Math.max(...ftsRows.map((r) => Math.abs(r.rank)));
        return ftsRows.slice(0, limit).map((row) => {
          const ftsScore = maxRank > 0 ? 1 - Math.abs(row.rank) / maxRank : 0.5;
          return { id: row.id, content: row.content, score: row.importance * 0.4 + ftsScore * 0.6 };
        });
      }
    } catch {
      // FTS5 query failed (e.g., special chars), fall through to LIKE
    }

    // Phase 2: Fallback to LIKE-based search
    const conditions = words.map(() => 'LOWER(content) LIKE ?');
    const params = words.map((w) => `%${w}%`);

    const rows = this.#db
      .prepare(
        `SELECT id, content, importance FROM memories
         WHERE ${conditions.join(' OR ')}
         ORDER BY importance DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: string;
      content: string;
      importance: number;
    }>;

    return rows.map((row) => {
      let score = row.importance;
      const contentLower = row.content.toLowerCase();
      for (const word of words) {
        const matches = contentLower.split(word).length - 1;
        score += matches * 0.1;
      }
      return { id: row.id, content: row.content, score };
    });
  }

  /**
   * Hybrid vector + keyword search across memories.
   * Combines FTS5 BM25 ranking with cosine similarity when embeddings are available.
   */
  hybridSearchMemories(
    query: string,
    queryEmbedding: number[] | null,
    limit = 20,
    vectorWeight = 0.6,
  ): Array<{ id: string; content: string; score: number; vectorScore: number; bm25Score: number }> {
    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) return [];

    // Collect BM25 results from FTS5
    const bm25Results = new Map<string, { id: string; content: string; bm25Score: number }>();
    try {
      const ftsQuery = words.map((w) => `"${w}"`).join(' OR ');
      const ftsRows = this.#db
        .prepare(
          `SELECT m.id, m.content, rank
           FROM memories_fts fts
           JOIN memories m ON m.rowid = fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit * 3) as Array<{
        id: string;
        content: string;
        rank: number;
      }>;

      if (ftsRows.length > 0) {
        const maxRank = Math.max(...ftsRows.map((r) => Math.abs(r.rank)));
        for (const row of ftsRows) {
          const score = maxRank > 0 ? 1 - Math.abs(row.rank) / maxRank : 0.5;
          bm25Results.set(row.id, { id: row.id, content: row.content, bm25Score: score });
        }
      }
    } catch {
      // FTS5 unavailable, rely on LIKE fallback
      const conditions = words.map(() => 'LOWER(content) LIKE ?');
      const params = words.map((w) => `%${w}%`);
      const rows = this.#db
        .prepare(
          `SELECT id, content, importance FROM memories WHERE ${conditions.join(' OR ')} LIMIT ?`,
        )
        .all(...params, limit * 3) as Array<{ id: string; content: string; importance: number }>;

      for (const row of rows) {
        let matchCount = 0;
        const lower = row.content.toLowerCase();
        for (const w of words) {
          matchCount += lower.split(w).length - 1;
        }
        bm25Results.set(row.id, {
          id: row.id,
          content: row.content,
          bm25Score: Math.min(1, matchCount * 0.1 + row.importance * 0.5),
        });
      }
    }

    // Collect vector results if embedding is available
    const vectorResults = new Map<string, { id: string; vectorScore: number }>();
    if (queryEmbedding && queryEmbedding.length > 0) {
      const allEmbeddings = this.loadAllMemoriesWithEmbeddings();
      for (const mem of allEmbeddings) {
        const sim = this.cosineSimilarity(queryEmbedding, mem.embedding);
        if (sim > 0.1) {
          vectorResults.set(mem.id, { id: mem.id, vectorScore: sim });
        }
      }
    }

    // Merge scores
    const allIds = new Set([...bm25Results.keys(), ...vectorResults.keys()]);
    const merged: Array<{
      id: string;
      content: string;
      score: number;
      vectorScore: number;
      bm25Score: number;
    }> = [];

    for (const id of allIds) {
      const bm25 = bm25Results.get(id);
      const vec = vectorResults.get(id);
      const bm25Score = bm25?.bm25Score ?? 0;
      const vectorScore = vec?.vectorScore ?? 0;
      const score = bm25Score * (1 - vectorWeight) + vectorScore * vectorWeight;
      merged.push({
        id,
        content: bm25?.content ?? '',
        score,
        vectorScore,
        bm25Score,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  updateMemoryImportance(id: string, importance: number): void {
    this.#write(
      'UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?',
      [Math.max(0, Math.min(1, importance)), Date.now(), id],
    );
  }

  deleteMemory(id: string): void {
    this.#write('DELETE FROM memories WHERE id = ?', [id]);
  }

  pruneLowImportanceMemories(threshold: number): number {
    const result = this.#db
      .prepare('DELETE FROM memories WHERE importance < ?')
      .run(threshold);
    return result.changes;
  }

  getMemoryStats(): { total: number; episodic: number; semantic: number; avgImportance: number } {
    const total = (this.#db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    const episodic = (this.#db.prepare("SELECT COUNT(*) as c FROM memories WHERE type = 'episodic'").get() as { c: number }).c;
    const semantic = (this.#db.prepare("SELECT COUNT(*) as c FROM memories WHERE type = 'semantic'").get() as { c: number }).c;
    const avg = (this.#db.prepare('SELECT AVG(importance) as a FROM memories').get() as { a: number | null }).a ?? 0;
    return { total, episodic, semantic, avgImportance: avg };
  }

  // -----------------------------------------------------------------------
  // Memory Relations
  // -----------------------------------------------------------------------

  addMemoryRelation(memoryId: string, relatedId: string, relationType: string): void {
    this.#write(
      'INSERT OR IGNORE INTO memory_relations (memory_id, related_id, relation_type, created_at) VALUES (?, ?, ?, ?)',
      [memoryId, relatedId, relationType, Date.now()],
    );
  }

  getMemoryRelations(memoryId: string): string[] {
    const rows = this.#db
      .prepare('SELECT related_id FROM memory_relations WHERE memory_id = ?')
      .all(memoryId) as Array<{ related_id: string }>;
    return rows.map((r) => r.related_id);
  }

  // -----------------------------------------------------------------------
  // Memory Embeddings
  // -----------------------------------------------------------------------

  saveMemoryEmbedding(memoryId: string, embedding: number[]): void {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    this.#write('UPDATE memories SET embedding = ? WHERE id = ?', [buffer, memoryId]);
  }

  loadMemoryEmbedding(memoryId: string): number[] | null {
    const row = this.#db
      .prepare('SELECT embedding FROM memories WHERE id = ?')
      .get(memoryId) as { embedding: Buffer | null } | undefined;
    if (!row?.embedding) return null;
    return Array.from(new Float32Array(row.embedding.buffer));
  }

  loadAllMemoriesWithEmbeddings(): Array<{
    id: string;
    content: string;
    embedding: number[];
    type: string;
    tags: string[];
    importance: number;
  }> {
    const rows = this.#db
      .prepare('SELECT id, content, embedding, type, tags, importance FROM memories WHERE embedding IS NOT NULL LIMIT 10000')
      .all() as Array<{
      id: string;
      content: string;
      embedding: Buffer;
      type: string;
      tags: string;
      importance: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      embedding: Array.from(new Float32Array(row.embedding.buffer)),
      type: row.type,
      tags: JSON.parse(row.tags) as string[],
      importance: row.importance,
    }));
  }

  // -----------------------------------------------------------------------
  // Task CRUD (persistent task queue)
  // -----------------------------------------------------------------------

  saveTask(task: {
    id: string;
    type: string;
    priority: number;
    status: string;
    payload: Record<string, unknown>;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    result?: unknown;
    retries: number;
    maxRetries: number;
    timeout: number;
    tags?: string[];
  }): void {
    this.#write(
      `INSERT INTO tasks (id, type, priority, status, payload, created_at, started_at, completed_at, error, result, retries, max_retries, timeout, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         error = excluded.error,
         result = excluded.result,
         retries = excluded.retries`,
      [
        task.id,
        task.type,
        task.priority,
        task.status,
        JSON.stringify(task.payload),
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.error ?? null,
        task.result ? JSON.stringify(task.result) : null,
        task.retries,
        task.maxRetries,
        task.timeout,
        JSON.stringify(task.tags ?? []),
      ],
    );
  }

  loadTask(taskId: string): TaskRow | null {
    const row = this.#db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    return row ?? null;
  }

  loadTasks(status?: string): TaskRow[] {
    let query = 'SELECT * FROM tasks';
    const params: unknown[] = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY priority DESC, created_at ASC LIMIT 10000';
    return this.#db.prepare(query).all(...params) as TaskRow[];
  }

  deleteTask(taskId: string): void {
    this.#write('DELETE FROM tasks WHERE id = ?', [taskId]);
  }

  recoverInterruptedTasks(): number {
    const result = this.withRetry(() => {
      return this.#db
        .prepare(
          `UPDATE tasks SET status = 'failed', error = 'Interrupted before recovery', completed_at = ?
         WHERE status = 'running'`,
        )
        .run(Date.now());
    });
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // PnL Snapshot compat (reads from portfolio_snapshots, UI-compatible format)
  // -----------------------------------------------------------------------

  loadPnlSnapshots(since?: number, limit = 500): Array<{
    timestamp: number;
    totalValue: number;
    unrealizedPnl: number;
    realizedPnl: number;
    positions: unknown;
  }> {
    let query = 'SELECT * FROM portfolio_snapshots';
    const params: unknown[] = [];
    if (since) {
      query += ' WHERE taken_at >= ?';
      params.push(since);
    }
    query += ' ORDER BY taken_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.#db.prepare(query).all(...params) as Array<{
      taken_at: number;
      total_value: number;
      unrealized_pnl: number;
      realized_pnl: number;
      snapshot: string;
    }>;

    return rows.map((row) => ({
      timestamp: row.taken_at,
      totalValue: row.total_value,
      unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl,
      positions: JSON.parse(row.snapshot),
    }));
  }

  // -----------------------------------------------------------------------
  // Trade compat (UI-compatible format)
  // -----------------------------------------------------------------------

  loadTradesCompat(filter?: {
    exchange?: string;
    strategy?: string;
    since?: number;
    limit?: number;
  }): Array<{
    id: string;
    timestamp: number;
    exchange: string;
    symbol: string;
    side: string;
    size: number;
    price: number;
    pnl: number | null;
    fees: number | null;
    strategy: string | null;
    rationale: string | null;
  }> {
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.exchange) {
      sql += ' AND exchange = ?';
      params.push(filter.exchange);
    }
    if (filter?.strategy) {
      sql += ' AND strategy = ?';
      params.push(filter.strategy);
    }
    if (filter?.since) {
      sql += ' AND opened_at >= ?';
      params.push(filter.since);
    }

    sql += ' ORDER BY opened_at DESC LIMIT ?';
    params.push(filter?.limit ?? 500);

    const rows = this.#db.prepare(sql).all(...params) as Array<{
      id: string;
      opened_at: number;
      exchange: string;
      symbol: string;
      side: string;
      quantity: number;
      entry_price: number;
      pnl: number | null;
      fees: number | null;
      strategy: string | null;
      rationale: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.opened_at,
      exchange: row.exchange,
      symbol: row.symbol,
      side: row.side,
      size: row.quantity,
      price: row.entry_price,
      pnl: row.pnl,
      fees: row.fees,
      strategy: row.strategy,
      rationale: row.rationale,
    }));
  }

  saveTradeCompat(trade: {
    id: string;
    timestamp: number;
    exchange: string;
    symbol: string;
    side: string;
    size: number;
    price: number;
    pnl?: number;
    fees?: number;
    strategy?: string;
    rationale?: string;
  }): void {
    this.#write(
      `INSERT OR REPLACE INTO trades
       (id, session_id, symbol, side, entry_price, quantity, pnl, status, exchange, fees, strategy, rationale, opened_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      [
        trade.id,
        'default',
        trade.symbol,
        trade.side === 'buy' ? 'long' : 'short',
        trade.price,
        trade.size,
        trade.pnl ?? null,
        trade.pnl != null ? 'closed' : 'open',
        trade.exchange,
        trade.fees ?? null,
        trade.strategy ?? null,
        trade.rationale ?? null,
        trade.timestamp,
      ],
    );
  }

  // -----------------------------------------------------------------------
  // Cron Job compat (UI-compatible format)
  // -----------------------------------------------------------------------

  saveCronJobCompat(job: {
    id: string;
    name: string;
    schedule: string;
    taskType: string;
    payload: Record<string, unknown>;
    enabled: boolean;
    lastRunAt?: number;
    nextRunAt: number;
    createdAt: number;
    maxRuns?: number;
    runCount: number;
  }): void {
    this.#write(
      `INSERT INTO cron_jobs
       (id, name, prompt, command, schedule_kind, schedule_display,
        schedule_interval_ms, schedule_expression, schedule_run_at,
        skills, deliver, enabled, state, last_status, last_error,
        repeat_count, completed_runs, tags, pipeline, approval_status,
        execution_policy, wake_agent, context_from, allowed_tools,
        disallowed_tools, model_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, prompt=excluded.prompt, command=excluded.command,
        schedule_kind=excluded.schedule_kind, schedule_display=excluded.schedule_display,
        schedule_interval_ms=excluded.schedule_interval_ms, schedule_expression=excluded.schedule_expression,
        schedule_run_at=excluded.schedule_run_at, deliver=excluded.deliver,
        enabled=excluded.enabled, state=excluded.state,
        last_status=excluded.last_status, last_error=excluded.last_error,
        repeat_count=excluded.repeat_count, completed_runs=excluded.completed_runs,
        updated_at=excluded.updated_at`,
      [
        job.id,
        job.name,
        null,
        job.taskType,
        'cron',
        job.schedule,
        null,
        null,
        job.lastRunAt ?? null,
        null,
        JSON.stringify(job.payload),
        job.enabled ? 1 : 0,
        job.enabled ? 'scheduled' : 'paused',
        null,
        null,
        job.maxRuns ?? null,
        job.runCount,
        job.createdAt,
        Date.now(),
      ],
    );
  }

  loadCronJobsCompat(): Array<{
    id: string;
    name: string;
    schedule: string;
    taskType: string;
    payload: Record<string, unknown>;
    enabled: boolean;
    lastRunAt: number | null;
    nextRunAt: number;
    createdAt: number;
    maxRuns: number | null;
    runCount: number;
  }> {
    const rows = this.#db
      .prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC LIMIT 10000')
      .all() as CronJobRow[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule_display,
      taskType: row.command ?? '',
      payload: JSON.parse(row.deliver || '{}') as Record<string, unknown>,
      enabled: row.enabled === 1,
      lastRunAt: row.schedule_run_at,
      nextRunAt: row.schedule_run_at ?? row.created_at,
      createdAt: row.created_at,
      maxRuns: row.repeat_count,
      runCount: row.completed_runs,
    }));
  }

  // -----------------------------------------------------------------------
  // Goal compat (UI-compatible format)
  // -----------------------------------------------------------------------

  saveGoalCompat(goal: {
    id: string;
    objective: string;
    status: string;
    tokenBudget?: number;
    tokensUsed: number;
    sessionId?: string;
    planId?: string;
    progress?: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    validationCriteria?: string;
    exclusions?: string[];
  }): void {
    this.#write(
      `INSERT INTO goals
       (id, session_id, title, description, status, claims, evidence, budget,
        completion_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, '{}', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         title = excluded.title,
         description = excluded.description,
         status = excluded.status,
         budget = excluded.budget,
         updated_at = excluded.updated_at`,
      [
        goal.id,
        goal.sessionId ?? 'default',
        goal.objective,
        goal.objective,
        goal.status,
        JSON.stringify({
          tokenBudget: goal.tokenBudget ?? null,
          tokensUsed: goal.tokensUsed,
          planId: goal.planId ?? null,
          progress: goal.progress ?? {},
          validationCriteria: goal.validationCriteria ?? null,
          exclusions: goal.exclusions ?? [],
          completedAt: goal.completedAt ?? null,
        }),
        goal.createdAt,
        goal.updatedAt,
      ],
    );
  }

  loadActiveGoalCompat(): {
    id: string;
    objective: string;
    status: string;
    tokenBudget: number | null;
    tokensUsed: number;
    sessionId: string | null;
    planId: string | null;
    progress: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
    validationCriteria: string | null;
    exclusions: string[];
  } | null {
    const row = this.#db
      .prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get() as GoalRow | undefined;

    if (!row) return null;

    const budget = JSON.parse(row.budget || '{}') as Record<string, unknown>;
    return {
      id: row.id,
      objective: row.title,
      status: row.status,
      tokenBudget: (budget.tokenBudget as number) ?? null,
      tokensUsed: (budget.tokensUsed as number) ?? 0,
      sessionId: row.session_id,
      planId: (budget.planId as string) ?? null,
      progress: (budget.progress as Record<string, unknown>) ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: (budget.completedAt as number) ?? null,
      validationCriteria: (budget.validationCriteria as string) ?? null,
      exclusions: (budget.exclusions as string[]) ?? [],
    };
  }

  // -----------------------------------------------------------------------
  // Conversation Session CRUD
  // -----------------------------------------------------------------------

  saveConversationSession(row: ConversationSessionRow): void {
    this.#write(
      `INSERT INTO conversation_sessions
       (id, parent_id, title, slug, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id,
         title = excluded.title,
         slug = excluded.slug,
         status = excluded.status,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      [row.id, row.parent_id, row.title, row.slug, row.status, row.metadata, row.created_at, row.updated_at],
    );
  }

  getConversationSession(id: string): ConversationSessionRow | null {
    const row = this.#db
      .prepare('SELECT * FROM conversation_sessions WHERE id = ?')
      .get(id) as ConversationSessionRow | undefined;
    return row ?? null;
  }

  listConversationSessions(filters?: { status?: string }): ConversationSessionRow[] {
    let sql = 'SELECT * FROM conversation_sessions WHERE 1=1';
    const params: unknown[] = [];
    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    sql += ' ORDER BY updated_at DESC';
    return this.#db.prepare(sql).all(...params) as ConversationSessionRow[];
  }

  deleteConversationSession(id: string): void {
    this.#write('DELETE FROM conversation_sessions WHERE id = ?', [id]);
  }

  // -----------------------------------------------------------------------
  // Conversation Message CRUD
  // -----------------------------------------------------------------------

  saveConversationMessage(row: ConversationMessageRow): void {
    this.#write(
      `INSERT INTO conversation_messages
       (id, session_id, role, parts, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_id, row.role, row.parts, row.token_count, row.created_at],
    );
  }

  replaceConversationMessages(sessionId: string, rows: ConversationMessageRow[]): void {
    if (rows.some((row) => row.session_id !== sessionId)) {
      throw new Error('Conversation message session_id must match replacement session');
    }
    this.withRetry(() => {
      this.#db.prepare('DELETE FROM conversation_messages WHERE session_id = ?').run(sessionId);
      const insert = this.#db.prepare(
        `INSERT INTO conversation_messages (id, session_id, role, parts, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(row.id, row.session_id, row.role, row.parts, row.token_count, row.created_at);
      }
    });
  }

  getConversationMessages(sessionId: string, limit?: number): ConversationMessageRow[] {
    const sql = limit
      ? 'SELECT * FROM conversation_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?'
      : 'SELECT * FROM conversation_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC';
    const params = limit ? [sessionId, limit] : [sessionId];
    return this.#db.prepare(sql).all(...params) as ConversationMessageRow[];
  }

  listAllConversationMessages(): ConversationMessageRow[] {
    return this.#db
      .prepare('SELECT * FROM conversation_messages ORDER BY created_at ASC LIMIT 50000')
      .all() as ConversationMessageRow[];
  }

  deleteConversationMessages(sessionId: string): void {
    this.#write('DELETE FROM conversation_messages WHERE session_id = ?', [sessionId]);
  }

  // -----------------------------------------------------------------------
  // Compaction Record CRUD
  // -----------------------------------------------------------------------

  saveCompactionRecord(row: CompactionRecordRow): void {
    this.#write(
      `INSERT INTO compaction_records
       (id, session_id, trigger_type, tokens_before, tokens_after, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_id, row.trigger_type, row.tokens_before, row.tokens_after, row.summary, row.created_at],
    );
  }

  listCompactionRecords(sessionId?: string, limit?: number): CompactionRecordRow[] {
    let sql = 'SELECT * FROM compaction_records WHERE 1=1';
    const params: unknown[] = [];
    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }
    sql += ' ORDER BY created_at DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return this.#db.prepare(sql).all(...params) as CompactionRecordRow[];
  }

  // -----------------------------------------------------------------------
  // Query helpers
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only SQL query and return the results.
   */
  query<T>(sql: string, params?: unknown[]): T[] {
    if (params && params.length > 0) {
      return this.#db.prepare(sql).all(...params) as T[];
    }
    return this.#db.prepare(sql).all() as T[];
  }

  /**
   * Execute a write SQL statement (for migrations / setup).
   * Wrapped in withRetry for cross-process contention handling.
   */
  exec(sql: string): void {
    this.withRetry(() => {
      this.#db.exec(sql);
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close the database connection.
   */
  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a SQL column-definition block into individual column definitions,
 * respecting nested parentheses so commas inside CHECK(...) or DEFAULT
 * expressions are not treated as separators.
 */
function splitColumnDefinitions(block: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const ch of block) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

/**
 * Extract the column name from a SQL column definition.
 * The column name is the first token, with quotes stripped.
 */
function extractColumnName(columnDef: string): string | null {
  const trimmed = columnDef.trim();
  if (!trimmed) return null;

  // Match the first word, which may be quoted with double quotes, backticks, or brackets
  const match = trimmed.match(/^("(?:\\.|[^"])*"|`(?:\\.|[^`])*`|\[(?:\\.|[^\[\]])*\]|\w+)/);
  if (!match) return null;

  let name = match[1]!;
  // Strip surrounding quotes
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith('`') && name.endsWith('`'))
  ) {
    name = name.slice(1, -1);
  } else if (name.startsWith('[') && name.endsWith(']')) {
    name = name.slice(1, -1);
  }

  return name;
}
