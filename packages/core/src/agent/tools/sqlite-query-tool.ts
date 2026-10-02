/**
 * SqliteQueryTool — Read-only SQL query tool against state.db.
 *
 * Allows the LLM to run SELECT, PRAGMA, and EXPLAIN queries
 * for introspection and debugging of trades, positions, cron jobs,
 * goals, sessions, and portfolio snapshots.
 *
 * SAFETY: Only read-only statements are allowed.
 * All mutation statements (INSERT, UPDATE, DELETE, DROP, ALTER,
 * CREATE, VACUUM, REINDEX, ATTACH, DETACH) are rejected.
 */

import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { StateDb } from '../../state-db/state-db';

/** Regex that matches SQL mutations — any statement that modifies database state. */
const MUTATION_REGEX = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|VACUUM|REINDEX|ATTACH|DETACH)\b/i;

/** Maximum allowed query length in characters. */
const MAX_QUERY_LENGTH = 2000;

export class SqliteQueryTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'sqlite_query',
    description:
      'Execute read-only SQL queries (SELECT, PRAGMA, EXPLAIN) against the unified state.db for introspection, debugging, and analysis of trades, positions, cron jobs, goals, sessions, and portfolio snapshots.',
    category: 'analysis',
    inputSchema: {
      sql: 'string',
      params: 'array?',
    },
    outputSchema: { rows: 'array', rowCount: 'number', durationMs: 'number' },
    permissionsRequired: ['tool.sqlite_query'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 15000,
  };

  constructor(private db: StateDb) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const sql = (call.args.sql as string).trim();
      const params = call.args.params as unknown[] | undefined;

      // Validate: only read-only queries
      if (MUTATION_REGEX.test(sql)) {
        return {
          success: false,
          error: `Only read-only queries are allowed (SELECT, PRAGMA, EXPLAIN). Rejected: ${sql.slice(0, 100)}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Validate length
      if (sql.length > MAX_QUERY_LENGTH) {
        return {
          success: false,
          error: `Query too long (${sql.length} chars). Max ${MAX_QUERY_LENGTH} characters.`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Execute query via StateDb.query<T> (read-only)
      const rows = this.db.query<Record<string, unknown>>(sql, params);

      return {
        success: true,
        data: {
          rows,
          rowCount: rows.length,
          durationMs: Date.now() - start,
          sql: sql.slice(0, 200), // truncated preview
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}
