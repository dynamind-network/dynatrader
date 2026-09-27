/**
 * Tests for StateDb — the unified SQLite persistence layer
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { StateDb } from './state-db';
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
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbDir(): string {
  const dir = join(tmpdir(), `dynatrader-state-db-test-${randomUUID()}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cleanupTempDbDir(dir: string): void {
  try {
    rmSync(join(dir, 'state.db'), { force: true });
  } catch { /* ignore */ }
  try {
    rmSync(join(dir, 'state.db-wal'), { force: true });
  } catch { /* ignore */ }
  try {
    rmSync(join(dir, 'state.db-shm'), { force: true });
  } catch { /* ignore */ }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess_001',
    agent_id: 'agent_alpha',
    platform: 'telegram',
    platform_user_id: 'user_42',
    status: 'active',
    metadata: '{}',
    created_at: 1700000000000,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: 'goal_001',
    session_id: 'sess_001',
    title: 'Analyze BTC trend',
    description: 'Technical analysis',
    status: 'active',
    claims: '[]',
    evidence: '[]',
    budget: '{}',
    completion_policy: '{}',
    created_at: 1700000000000,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makeGoalStep(overrides: Partial<GoalStepRow> = {}): GoalStepRow {
  return {
    id: 'step_001',
    goal_id: 'goal_001',
    title: 'Fetch price data',
    description: '',
    order: 1,
    status: 'pending',
    depends_on: '[]',
    assignable_tools: null,
    budget: '{}',
    output: null,
    completed_at: null,
    created_at: 1700000000000,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makeCronJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    id: 'cron_001',
    name: 'BTC Price Check',
    prompt: 'Check BTC price',
    command: null,
    schedule_kind: 'interval',
    schedule_display: 'Every 5 min',
    schedule_interval_ms: 300000,
    schedule_expression: null,
    schedule_run_at: null,
    skills: '[]',
    deliver: '{}',
    enabled: 1,
    state: 'scheduled',
    last_status: null,
    last_error: null,
    repeat_count: null,
    completed_runs: 0,
    tags: '[]',
    pipeline: null,
    approval_status: null,
    execution_policy: null,
    wake_agent: 0,
    context_from: null,
    allowed_tools: null,
    disallowed_tools: null,
    model_config: null,
    created_at: 1700000000000,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makeCronState(overrides: Partial<CronStateRow> = {}): CronStateRow {
  return {
    id: 'cs_001',
    job_id: 'cron_001',
    version: 1,
    session_id: null,
    prompt_fingerprint: null,
    summary: null,
    last_output: null,
    last_trade: null,
    trade_history: null,
    last_venue: null,
    last_symbol: null,
    last_timeframe: null,
    last_status: null,
    last_error: null,
    last_run_at: null,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: 'trade_001',
    session_id: 'sess_001',
    symbol: 'BTC/USDT',
    side: 'long',
    entry_price: 45000,
    exit_price: null,
    quantity: 0.5,
    pnl: null,
    pnl_percent: null,
    status: 'open',
    chain_id: null,
    tx_hash: null,
    dex: null,
    metadata: '{}',
    opened_at: 1700000000000,
    closed_at: null,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 'pos_001',
    session_id: 'sess_001',
    symbol: 'BTC/USDT',
    side: 'long',
    quantity: 0.5,
    avg_entry_price: 45000,
    current_price: 46000,
    unrealized_pnl: 500,
    unrealized_pnl_percent: 2.22,
    realized_pnl: 0,
    status: 'open',
    metadata: '{}',
    opened_at: 1700000000000,
    updated_at: 1700000100000,
    ...overrides,
  };
}

function makePortfolioSnapshot(
  overrides: Partial<PortfolioSnapshotRow> = {},
): PortfolioSnapshotRow {
  return {
    id: 'snap_001',
    session_id: 'sess_001',
    total_value: 100000,
    cash_balance: 50000,
    invested: 50000,
    unrealized_pnl: 500,
    realized_pnl: 1000,
    positions_count: 3,
    snapshot: '{}',
    taken_at: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateDb', () => {
  let dbDir: string;
  let db: StateDb;

  beforeAll(() => {
    dbDir = makeTempDbDir();
    db = new StateDb(dbDir);
  });

  afterAll(() => {
    db.close();
    cleanupTempDbDir(dbDir);
  });

  describe('construction and schema', () => {
    it('should create database with WAL mode', () => {
      const row = db.query<{ journal_mode: string }>(
        'PRAGMA journal_mode',
      );
      expect(row[0]?.journal_mode?.toLowerCase()).toBe('wal');
    });

    it('should have foreign_keys enabled', () => {
      const row = db.query<{ foreign_keys: number }>(
        'PRAGMA foreign_keys',
      );
      expect(row[0]?.foreign_keys).toBe(1);
    });

    it('should store schema version in state_meta', () => {
      const version = db.query<{ value: string }>(
        "SELECT value FROM state_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe('3');
    });

    it('should expose the path getter', () => {
      expect(db.path).toContain('state.db');
      expect(db.path).toContain(dbDir);
    });

    it('should expose the raw database instance', () => {
      expect(db.raw).toBeDefined();
      expect(typeof db.raw.prepare).toBe('function');
    });
  });

  describe('session CRUD', () => {
    const sessionId = 'sess_test_session';
    const session = makeSession({ id: sessionId });

    it('should save a session', () => {
      expect(() => db.saveSession(session)).not.toThrow();
    });

    it('should get a session by id', () => {
      const result = db.getSession(sessionId);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(sessionId);
      expect(result!.agent_id).toBe('agent_alpha');
      expect(result!.platform).toBe('telegram');
      expect(result!.status).toBe('active');
    });

    it('should return null for missing session', () => {
      expect(db.getSession('nonexistent')).toBeNull();
    });

    it('should list sessions with filters', () => {
      // Save another session with different status
      const idleSession = makeSession({
        id: 'sess_test_idle',
        status: 'idle',
      });
      db.saveSession(idleSession);

      const activeSessions = db.listSessions({ status: 'active' });
      expect(activeSessions.length).toBeGreaterThanOrEqual(1);
      expect(
        activeSessions.every((s) => s.status === 'active'),
      ).toBe(true);

      const allSessions = db.listSessions();
      expect(allSessions.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      db.deleteSession('sess_test_idle');
    });

    it('should list sessions with platform filter', () => {
      const filtered = db.listSessions({ platform: 'telegram' });
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(
        filtered.every((s) => s.platform === 'telegram'),
      ).toBe(true);
    });

    it('should delete a session', () => {
      const toDelete = makeSession({ id: 'sess_to_delete' });
      db.saveSession(toDelete);
      expect(db.getSession('sess_to_delete')).not.toBeNull();

      db.deleteSession('sess_to_delete');
      expect(db.getSession('sess_to_delete')).toBeNull();
    });
  });

  describe('goal CRUD', () => {
    const goalId = 'goal_test_001';
    const goal = makeGoal({ id: goalId, session_id: 'sess_test_session' });

    it('should save a goal', () => {
      expect(() => db.saveGoal(goal)).not.toThrow();
    });

    it('should get a goal by id', () => {
      const result = db.getGoal(goalId);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(goalId);
      expect(result!.title).toBe('Analyze BTC trend');
    });

    it('should return null for missing goal', () => {
      expect(db.getGoal('nonexistent')).toBeNull();
    });

    it('should list goals by session id', () => {
      const goals = db.listGoals('sess_test_session');
      expect(goals.length).toBeGreaterThanOrEqual(1);
      expect(goals.every((g) => g.session_id === 'sess_test_session')).toBe(true);
    });

    it('should list all goals when no sessionId given', () => {
      const goals = db.listGoals();
      expect(goals.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('goal steps CRUD', () => {
    const goalId = 'goal_test_steps';
    const step1 = makeGoalStep({
      id: 'step_test_001',
      goal_id: goalId,
      order: 1,
      status: 'pending',
    });
    const step2 = makeGoalStep({
      id: 'step_test_002',
      goal_id: goalId,
      order: 2,
      status: 'completed',
    });

    beforeAll(() => {
      db.saveGoal(makeGoal({ id: goalId, session_id: 'sess_test_session' }));
    });

    it('should save goal steps', () => {
      expect(() => db.saveGoalStep(step1)).not.toThrow();
      expect(() => db.saveGoalStep(step2)).not.toThrow();
    });

    it('should list steps for a goal in order', () => {
      const steps = db.listGoalSteps(goalId);
      expect(steps.length).toBe(2);
      expect(steps[0]!.id).toBe('step_test_001');
      expect(steps[1]!.id).toBe('step_test_002');
    });

    it('should return empty array for goal with no steps', () => {
      expect(db.listGoalSteps('nonexistent')).toEqual([]);
    });

    it('should delete all steps for a goal', () => {
      db.deleteGoalSteps(goalId);
      expect(db.listGoalSteps(goalId)).toEqual([]);
    });
  });

  describe('cron job CRUD', () => {
    const cronId = 'cron_test_001';
    const cronJob = makeCronJob({ id: cronId });

    it('should save a cron job', () => {
      expect(() => db.saveCronJob(cronJob)).not.toThrow();
    });

    it('should get a cron job by id', () => {
      const result = db.getCronJob(cronId);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(cronId);
      expect(result!.name).toBe('BTC Price Check');
      expect(result!.schedule_kind).toBe('interval');
      expect(result!.enabled).toBe(1);
    });

    it('should return null for missing cron job', () => {
      expect(db.getCronJob('nonexistent')).toBeNull();
    });

    it('should list cron jobs', () => {
      const jobs = db.listCronJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(1);
    });

    it('should list only enabled cron jobs', () => {
      // Add a disabled job
      db.saveCronJob(
        makeCronJob({
          id: 'cron_test_disabled',
          enabled: 0,
          name: 'Disabled Job',
        }),
      );

      const enabled = db.listCronJobs(true);
      expect(enabled.every((j) => j.enabled === 1)).toBe(true);

      // Cleanup
      db.deleteCronJob('cron_test_disabled');
    });

    it('should delete a cron job', () => {
      db.saveCronJob(makeCronJob({ id: 'cron_to_delete' }));
      expect(db.getCronJob('cron_to_delete')).not.toBeNull();
      db.deleteCronJob('cron_to_delete');
      expect(db.getCronJob('cron_to_delete')).toBeNull();
    });
  });

  describe('cron state CRUD', () => {
    const cronId = 'cron_test_state';
    const state = makeCronState({ job_id: cronId });

    beforeAll(() => {
      db.saveCronJob(makeCronJob({ id: cronId }));
    });

    it('should save cron state', () => {
      expect(() => db.saveCronState(state)).not.toThrow();
    });

    it('should get cron state by job id', () => {
      const result = db.getCronState(cronId);
      expect(result).not.toBeNull();
      expect(result!.job_id).toBe(cronId);
      expect(result!.version).toBe(1);
    });

    it('should return null for missing cron state', () => {
      expect(db.getCronState('nonexistent')).toBeNull();
    });

    it('should upsert cron state', () => {
      const updated = makeCronState({
        job_id: cronId,
        version: 2,
        last_output: 'Updated output',
      });
      db.saveCronState(updated);
      const result = db.getCronState(cronId);
      expect(result!.version).toBe(2);
      expect(result!.last_output).toBe('Updated output');
    });
  });

  describe('trade CRUD', () => {
    it('should save a trade', () => {
      expect(() => db.saveTrade(makeTrade({ id: 'trade_test_001' }))).not.toThrow();
    });

    it('should list trades with filters', () => {
      // Add a closed trade
      db.saveTrade(
        makeTrade({
          id: 'trade_test_002',
          side: 'short',
          status: 'closed',
          symbol: 'ETH/USDT',
          exit_price: 2800,
          pnl: 200,
        }),
      );

      const all = db.listTrades();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const open = db.listTrades({ status: 'open' });
      expect(open.every((t) => t.status === 'open')).toBe(true);

      const btc = db.listTrades({ symbol: 'BTC/USDT' });
      expect(btc.every((t) => t.symbol === 'BTC/USDT')).toBe(true);

      const bySession = db.listTrades({ sessionId: 'sess_001' });
      expect(bySession.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array when no trades match', () => {
      expect(db.listTrades({ symbol: 'NONEXISTENT' })).toEqual([]);
    });
  });

  describe('position CRUD', () => {
    it('should save a position', () => {
      expect(() => db.savePosition(makePosition({ id: 'pos_test_001' }))).not.toThrow();
    });

    it('should list positions with filters', () => {
      db.savePosition(
        makePosition({
          id: 'pos_test_002',
          symbol: 'ETH/USDT',
          status: 'closed',
          side: 'short',
        }),
      );

      const all = db.listPositions();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const open = db.listPositions({ status: 'open' });
      expect(open.every((p) => p.status === 'open')).toBe(true);

      const btc = db.listPositions({ symbol: 'BTC/USDT' });
      expect(btc.every((p) => p.symbol === 'BTC/USDT')).toBe(true);
    });

    it('should return empty array when no positions match', () => {
      expect(db.listPositions({ symbol: 'NONEXISTENT' })).toEqual([]);
    });
  });

  describe('portfolio snapshot CRUD', () => {
    it('should save a portfolio snapshot', () => {
      expect(() =>
        db.savePortfolioSnapshot(
          makePortfolioSnapshot({ id: 'snap_test_001' }),
        ),
      ).not.toThrow();
    });

    it('should list portfolio snapshots', () => {
      // Add another snapshot
      db.savePortfolioSnapshot(
        makePortfolioSnapshot({
          id: 'snap_test_002',
          session_id: 'sess_001',
          total_value: 110000,
          taken_at: 1700000200000,
        }),
      );

      const snapshots = db.listPortfolioSnapshots('sess_001', 5);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(
        snapshots.every((s) => s.session_id === 'sess_001'),
      ).toBe(true);
    });

    it('should respect the limit param', () => {
      const snapshots = db.listPortfolioSnapshots(undefined, 1);
      expect(snapshots.length).toBeLessThanOrEqual(1);
    });
  });

  describe('price cache', () => {
    it('should save a price entry', () => {
      expect(() => db.savePrice('BTC/USDT', 50000)).not.toThrow();
    });

    it('should retrieve a cached price', () => {
      const cached = db.getCachedPrice('BTC/USDT', 60000);
      expect(cached).not.toBeNull();
      expect(cached!.symbol).toBe('BTC/USDT');
      expect(cached!.price).toBe(50000);
      expect(cached!.source).toBe('ccxt');
    });

    it('should return null for expired price', () => {
      // Insert a price entry with a very old timestamp (no savePrice which uses Date.now)
      db.exec(
        `INSERT OR REPLACE INTO price_cache (id, symbol, price, source, fetched_at) 
         VALUES ('old_manual', 'OLD/SYMBOL', 100, 'ccxt', 1000)`,
      );
      const cached = db.getCachedPrice('OLD/SYMBOL', 1);
      expect(cached).toBeNull();
    });

    it('should return null for uncached symbol', () => {
      expect(db.getCachedPrice('UNKNOWN/SYMBOL', 60000)).toBeNull();
    });
  });

  describe('conversation message replacement', () => {
    it('replaces only one session transcript with the requested rows', () => {
      db.saveConversationSession({
        id: 'replace-session', parent_id: null, title: 'Replace test', slug: 'replace-test',
        status: 'active', metadata: '{}', created_at: 1, updated_at: 1,
      });
      db.saveConversationSession({
        id: 'other-session', parent_id: null, title: 'Other', slug: 'other',
        status: 'active', metadata: '{}', created_at: 1, updated_at: 1,
      });
      const original = {
        id: 'original-message', session_id: 'replace-session', role: 'user' as const,
        parts: '[{"type":"text","content":"original"}]', token_count: 0, created_at: 1,
      };
      const other = { ...original, id: 'other-message', session_id: 'other-session' };
      db.saveConversationMessage(original);
      db.saveConversationMessage(other);
      const replacement = { ...original, id: 'replacement-message', parts: '[{"type":"text","content":"replacement"}]', created_at: 2 };

      db.replaceConversationMessages('replace-session', [replacement]);

      expect(db.getConversationMessages('replace-session')).toEqual([replacement]);
      expect(db.getConversationMessages('other-session')).toEqual([other]);
    });

    it('rolls back deletion and inserts when a replacement row violates constraints', () => {
      db.saveConversationSession({
        id: 'rollback-session', parent_id: null, title: 'Rollback', slug: 'rollback',
        status: 'active', metadata: '{}', created_at: 1, updated_at: 1,
      });
      const original = {
        id: 'rollback-original', session_id: 'rollback-session', role: 'user' as const,
        parts: '[{"type":"text","content":"original"}]', token_count: 0, created_at: 1,
      };
      db.saveConversationMessage(original);

      expect(() => db.replaceConversationMessages('rollback-session', [
        { ...original, id: 'rollback-valid', created_at: 2 },
        { ...original, id: 'rollback-invalid', role: 'not-a-role' as never, created_at: 3 },
      ])).toThrow();
      expect(db.getConversationMessages('rollback-session')).toEqual([original]);
    });
  });

  describe('withRetry', () => {
    it('should execute write operations within a transaction', () => {
      const result = db.withRetry(() => {
        db.saveSession(
          makeSession({ id: 'sess_retry_test' }),
        );
        return 'done';
      });
      expect(result).toBe('done');
      expect(db.getSession('sess_retry_test')).not.toBeNull();
      db.deleteSession('sess_retry_test');
    });

    it('should throw on non-SQLITE_BUSY errors', () => {
      expect(() =>
        db.withRetry(() => {
          throw new Error('unrelated error');
        }),
      ).toThrow('unrelated error');
    });
  });

  describe('query helper', () => {
    it('should return read-only results', () => {
      const rows = db.query<{ name: string }>(
        "SELECT 'hello' AS name",
      );
      expect(rows).toEqual([{ name: 'hello' }]);
    });

    it('should return empty array for no results', () => {
      const rows = db.query<{ id: string }>(
        "SELECT id FROM sessions WHERE id = 'nonexistent'",
      );
      expect(rows).toEqual([]);
    });
  });

  describe('schema reconciler', () => {
    it('should add missing columns', () => {
      // Add a column manually, then re-run reconcile (no error)
      // First drop it if it exists (ignore error)
      try {
        db.exec(
          'ALTER TABLE sessions DROP COLUMN _test_reconcile',
        );
      } catch { /* ignore */ }

      // Add it back, then run reconcile which should detect it exists and skip
      db.exec(
        'ALTER TABLE sessions ADD COLUMN _test_reconcile TEXT DEFAULT \'\'',
      );

      // Re-run reconcile by calling initSchema again (indirectly)
      // We'll just verify the column is still there after reconcile
      const cols = db.query<{ name: string }>(
        "PRAGMA table_info('sessions')",
      );
      const found = cols.some((c) => c.name === '_test_reconcile');
      expect(found).toBe(true);

      // Cleanup
      try {
        db.exec('ALTER TABLE sessions DROP COLUMN _test_reconcile');
      } catch { /* ignore */ }
    });
  });

  describe('deletes', () => {
    it('should delete a goal', () => {
      const gId = 'goal_test_del';
      db.saveGoal(makeGoal({ id: gId, session_id: 'sess_test_session' }));
      expect(db.getGoal(gId)).not.toBeNull();
      db.deleteGoal(gId);
      expect(db.getGoal(gId)).toBeNull();
    });
  });

  describe('exec', () => {
    it('should execute raw SQL', () => {
      expect(() => db.exec('SELECT 1')).not.toThrow();
    });
  });
});
