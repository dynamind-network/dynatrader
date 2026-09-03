import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, MemoryStore } from '@dyna/contracts';

export class MemorySearchTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'memory_search',
    description: 'Search memory for relevant context',
    category: 'memory',
    inputSchema: {
      scope: 'string',
      text: 'string',
      topK: 'number?',
    },
    outputSchema: { results: 'array', count: 'number' },
    permissionsRequired: ['memory.search'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  constructor(private memoryStore: MemoryStore) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
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
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}
