import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { StateDb } from '../../state-db/state-db';
import { SqliteQueryTool } from './sqlite-query-tool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDbDir(): string {
  const dir = join(tmpdir(), `sqlite-query-test-${randomUUID()}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cleanDbDir(dir: string): void {
  for (const file of ['state.db', 'state.db-wal', 'state.db-shm']) {
    try {
      const p = join(dir, file);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
  try {
    if (existsSync(dir)) unlinkSync(dir);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteQueryTool', () => {
  let db: StateDb;
  let tool: SqliteQueryTool;
  const dir = getDbDir();

  beforeEach(() => {
    db = new StateDb(dir);
    tool = new SqliteQueryTool(db);

    // Seed some test data
    const now = Date.now();
    db.saveTrade({
      id: 't-1',
      session_id: 'sess-1',
      symbol: 'BTC/USD',
      side: 'long',
      entry_price: 50000,
      exit_price: null,
      quantity: 0.1,
      pnl: null,
      pnl_percent: null,
      status: 'open',
      chain_id: null,
      tx_hash: null,
      dex: null,
      metadata: '{}',
      opened_at: now,
      closed_at: null,
    });
    db.savePosition({
      id: 'p-1',
      session_id: 'sess-1',
      symbol: 'BTC/USD',
      side: 'long',
      quantity: 0.5,
      avg_entry_price: 49000,
      current_price: 50000,
      unrealized_pnl: 500,
      unrealized_pnl_percent: 1.02,
      realized_pnl: 0,
      status: 'open',
      metadata: '{}',
      opened_at: now,
      updated_at: now,
    });
  });

  afterEach(() => {
    db.close();
    cleanDbDir(dir);
  });

  it('executes SELECT query and returns rows', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'SELECT * FROM trades WHERE session_id = ?', params: ['sess-1'] },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol).toBe('BTC/USD');
    expect(data.rowCount).toBe(1);
  });

  it('rejects INSERT queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "INSERT INTO trades (id) VALUES ('x')" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects UPDATE queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "UPDATE trades SET status = 'closed' WHERE id = 't-1'" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects DELETE queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "DELETE FROM trades WHERE id = 't-1'" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects DROP queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'DROP TABLE trades' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects ALTER queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "ALTER TABLE trades ADD COLUMN foo TEXT" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects CREATE queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "CREATE TABLE foo (id TEXT)" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects VACUUM queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'VACUUM' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('supports PRAGMA queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'PRAGMA table_info(trades)' },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r: any) => r.name === 'symbol')).toBe(true);
  });

  it('supports EXPLAIN queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'EXPLAIN SELECT * FROM trades' },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects long queries over 2000 chars', async () => {
    const longSql = 'SELECT 1' + ' AND 1=1'.repeat(1000);
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: longSql },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too long');
  });

  it('handles bad SQL gracefully', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'SELECT invalid_sql_here' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns empty array for no results', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "SELECT * FROM trades WHERE symbol = 'NONEXISTENT'" },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(0);
    expect(data.rowCount).toBe(0);
  });

  it('queries positions table', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'SELECT * FROM positions' },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol).toBe('BTC/USD');
  });

  it('rejects REINDEX queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'REINDEX' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects ATTACH queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: "ATTACH DATABASE ':memory:' AS other" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('rejects DETACH queries', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'DETACH DATABASE other' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('handles empty params gracefully', async () => {
    const result = await tool.execute({
      tool: 'sqlite_query',
      args: { sql: 'SELECT COUNT(*) AS cnt FROM trades' },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.cnt).toBe(1);
  });

  it('has correct tool definition metadata', () => {
    expect(tool.definition.name).toBe('sqlite_query');
    expect(tool.definition.category).toBe('analysis');
    expect(tool.definition.riskLevel).toBe('low');
    expect(tool.definition.timeoutMs).toBe(15000);
    expect(tool.definition.permissionsRequired).toContain('tool.sqlite_query');
  });
});
