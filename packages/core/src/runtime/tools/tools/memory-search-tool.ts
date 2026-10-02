import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, MemoryStore } from '@dyna/contracts';
import type { MemoryEvent, MemoryStoreBackend } from '@dyna/memory-core';

type MemoryStoreWithBackend = MemoryStore & {
  getBackend?: () => MemoryStoreBackend;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export class MemorySearchTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'memory_search',
    description: 'Search memory for relevant context or list stored records without a search phrase',
    category: 'memory',
    inputSchema: {
      action: { type: 'string', enum: ['search', 'list'], optional: true },
      scope: 'string?',
      text: 'string?',
      topK: 'number?',
      limit: 'number?',
    },
    outputSchema: { results: 'array', records: 'array?', count: 'number', scopes: 'array?' },
    permissionsRequired: ['memory.search'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  constructor(private memoryStore: MemoryStore) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action ?? 'search';
      if (action !== 'search' && action !== 'list') {
        return this.failure('action must be one of: search, list', start);
      }

      if (action === 'list') {
        return await this.listRecords(call, start);
      }

      const scope = call.args.scope as string | undefined;
      if (!scope || typeof scope !== 'string') {
        return {
          success: false,
          error: 'scope must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const text = call.args.text as string | undefined;
      if (!text || typeof text !== 'string') {
        return {
          success: false,
          error: 'text must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const topK = (call.args.topK as number | undefined) ?? 20;

      const results = await this.memoryStore.search({ scope, text, topK });

      const serialized = results.map((r) => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
      }));

      return {
        success: true,
        data: {
          results: serialized,
          count: serialized.length,
          scope,
          query: text,
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return this.failure((err as Error).message ?? String(err), start);
    }
  }

  private async listRecords(call: ToolCall, start: number): Promise<ToolResult> {
    const rawScope = call.args.scope;
    if (rawScope !== undefined && (typeof rawScope !== 'string' || !rawScope.trim())) {
      return this.failure('scope must be a non-empty string when provided', start);
    }

    const requestedLimit = call.args.limit ?? call.args.topK;
    if (requestedLimit !== undefined && (typeof requestedLimit !== 'number' || !Number.isInteger(requestedLimit) || requestedLimit < 1)) {
      return this.failure('limit must be a positive integer', start);
    }

    const limit = Math.min((requestedLimit as number | undefined) ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const scope = typeof rawScope === 'string' ? rawScope.trim() : undefined;
    const backend = (this.memoryStore as MemoryStoreWithBackend).getBackend?.();

    if (!backend && !scope) {
      return this.failure('listing all memory scopes requires a memory backend that supports unfiltered record listing', start);
    }

    if (!backend) {
      // Compatibility path for MemoryStore adapters that only expose scoped search.
      const results = await this.memoryStore.search({ scope: scope!, text: '', topK: limit + 1 });
      const page = results.slice(0, limit);
      const records = page.map((record) => ({
        id: record.id,
        scope,
        payload: record.payload,
        timestamp: record.timestamp.toISOString(),
      }));
      return {
        success: true,
        data: { action: 'list', records, results: records, count: records.length, scope, limit, hasMore: results.length > limit },
        durationMs: Date.now() - start,
        truncated: results.length > limit,
      };
    }

    // Empty text invokes the backend's filter/list path. No wildcard or phrase search is used.
    const matches = await backend.search({ ...(scope ? { scope } : {}), limit: limit + 1 });
    const page = matches.slice(0, limit);
    const records: Array<Record<string, unknown>> = [];
    for (const match of page) {
      const event: MemoryEvent | null = await backend.get(match.id);
      if (!event) continue;
      records.push({
        id: event.id,
        scope: event.scope,
        kind: event.kind,
        payload: event.payload,
        timestamp: event.timestamp.toISOString(),
        metadata: event.metadata ?? {},
      });
    }

    const scopes = [...new Set(records.map((record) => record.scope as string))].sort();
    return {
      success: true,
      data: { action: 'list', records, results: records, count: records.length, scope: scope ?? null, scopes, limit, hasMore: matches.length > limit },
      durationMs: Date.now() - start,
      truncated: matches.length > limit,
    };
  }

  private failure(error: string, start: number): ToolResult {
    return { success: false, error, durationMs: Date.now() - start, truncated: false };
  }
}
