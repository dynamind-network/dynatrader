import type {
  ToolCall,
  ToolResult,
  ToolHandler,
  ToolRegistry,
  ToolCategory,
} from '@dyna/contracts';
import type { AuditTrail } from '@dyna/audit';
import { packText } from '../context-packager';

export interface ToolRegistryConfig {
  auditTrail?: AuditTrail;
  defaultMaxOutputLength?: number;
  /** Enable caching for read-only tools. Default: false */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds. Default: 300_000 (5 min) */
  cacheTtlMs?: number;
  /** User message patterns that bypass cache (e.g., "refresh", "recheck") */
  cacheBypassPatterns?: string[];
}

export class ToolRegistryImpl implements ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  private auditTrail?: AuditTrail;
  private maxOutputLength: number;
  private cacheEnabled: boolean;
  private cacheTtlMs: number;
  private cacheBypassPatterns: string[];
  private cache = new Map<string, { result: ToolResult; expiresAt: number }>();

  constructor(config?: ToolRegistryConfig) {
    this.auditTrail = config?.auditTrail;
    this.maxOutputLength = config?.defaultMaxOutputLength ?? 100 * 1024;
    this.cacheEnabled = config?.cacheEnabled ?? false;
    this.cacheTtlMs = config?.cacheTtlMs ?? 300_000;
    this.cacheBypassPatterns = config?.cacheBypassPatterns ?? ['refresh', 'recheck', 'reload', 'update'];
  }

  register(handler: ToolHandler): void {
    this.handlers.set(handler.definition.name, handler);
  }

  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  get(tool: string): ToolHandler | undefined {
    return this.handlers.get(tool);
  }

  list(category?: ToolCategory): ToolHandler[] {
    const all = Array.from(this.handlers.values());
    if (category !== undefined) {
      return all.filter((h) => h.definition.category === category);
    }
    return all;
  }

  /**
   * Create a restricted view of this registry.
   * The returned registry only exposes tools matching the allow list (if provided)
   * and excludes tools in the deny list. Used for sub-agent scoped tool sets.
   */
  restrict(options: { allow?: string[]; deny?: string[] }): ToolRegistry {
    const allowSet = options.allow ? new Set(options.allow) : undefined;
    const denySet = options.deny ? new Set(options.deny) : undefined;

    const restricted = new ToolRegistryImpl({
      auditTrail: this.auditTrail,
      defaultMaxOutputLength: this.maxOutputLength,
      cacheEnabled: this.cacheEnabled,
      cacheTtlMs: this.cacheTtlMs,
      cacheBypassPatterns: this.cacheBypassPatterns,
    });

    for (const [name, handler] of this.handlers) {
      const allowedByAllow = !allowSet || allowSet.has(name);
      const deniedByDeny = denySet?.has(name) ?? false;
      if (allowedByAllow && !deniedByDeny) {
        restricted.handlers.set(name, handler);
      }
    }

    return restricted;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();

    const handler = this.handlers.get(call.tool);
    if (!handler) {
      return {
        success: false,
        error: `Unknown tool: ${call.tool}`,
        durationMs: 0,
        truncated: false,
      };
    }

    // Cache check for read-only tools
    if (this.cacheEnabled && handler.definition.readOnly === true) {
      const sortedArgs = Object.keys(call.args)
        .sort()
        .reduce((o, k) => { o[k] = call.args[k]; return o; }, {} as Record<string, unknown>);
      const cacheKey = `${call.tool}:${JSON.stringify(sortedArgs)}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        // Clone cached result to prevent mutation
        return JSON.parse(JSON.stringify(cached.result));
      }
      // Cache miss — execute and store
      const finalResult = await this.executeInternal(call, handler, start);
      this.cache.set(cacheKey, { result: finalResult, expiresAt: Date.now() + this.cacheTtlMs });
      return JSON.parse(JSON.stringify(finalResult));
    }

    return this.executeInternal(call, handler, start);
  }

  private async executeInternal(call: ToolCall, handler: ToolHandler, start: number): Promise<ToolResult> {
    const timeout = handler.definition.timeoutMs;

    let result: ToolResult;

    try {
      const executionPromise = handler.execute(call);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool '${call.tool}' timed out after ${timeout}ms`)), timeout),
      );

      const handlerResult = await Promise.race([executionPromise, timeoutPromise]);
      result = handlerResult;
    } catch (err) {
      result = {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const durationMs = Date.now() - start;

    // Apply truncation if result data is too large
    let truncated = result.truncated;
    let finalData = result.data;

    if (typeof finalData === 'string' && finalData.length > this.maxOutputLength) {
      finalData = packText(finalData, this.maxOutputLength).text;
      truncated = true;
    } else if (typeof finalData === 'object' && finalData !== null) {
      // Check stdout/stderr fields in data
      const dataObj = finalData as Record<string, unknown>;
      if (typeof dataObj.stdout === 'string' && (dataObj.stdout as string).length > this.maxOutputLength) {
        dataObj.stdout = packText(dataObj.stdout as string, this.maxOutputLength).text;
        truncated = true;
      }
      if (typeof dataObj.stderr === 'string' && (dataObj.stderr as string).length > this.maxOutputLength) {
        dataObj.stderr = packText(dataObj.stderr as string, this.maxOutputLength).text;
        truncated = true;
      }
      if (typeof dataObj.content === 'string' && (dataObj.content as string).length > this.maxOutputLength) {
        dataObj.content = packText(dataObj.content as string, this.maxOutputLength).text;
        truncated = true;
      }
    }

    // Also truncate top-level stdout/stderr if present
    if (typeof result.stdout === 'string' && result.stdout.length > this.maxOutputLength) {
      result.stdout = packText(result.stdout, this.maxOutputLength).text;
      truncated = true;
    }
    if (typeof result.stderr === 'string' && result.stderr.length > this.maxOutputLength) {
      result.stderr = packText(result.stderr, this.maxOutputLength).text;
      truncated = true;
    }

    const finalResult: ToolResult = {
      success: result.success,
      durationMs,
      truncated,
    };

    if (result.error !== undefined) {
      finalResult.error = result.error;
    }
    if (finalData !== undefined) {
      finalResult.data = finalData;
    }
    if (result.stdout !== undefined) {
      finalResult.stdout = result.stdout;
    }
    if (result.stderr !== undefined) {
      finalResult.stderr = result.stderr;
    }

    // Audit trail
    if (this.auditTrail) {
      await this.auditTrail.record({
        type: 'tool_call',
        actor: 'system',
        actorType: 'tool',
        action: `tool_execute:${call.tool}`,
        resource: call.tool,
        result: finalResult.success ? 'success' : 'failure',
        details: {
          args: call.args,
          correlationId: call.correlationId,
          durationMs,
          truncated,
        },
      });
    }

    return finalResult;
  }

  /**
   * Execute multiple tool calls. Tools with canRunInParallel=true run concurrently.
   * Tools without it run sequentially in order.
   */
  async executeBatch(calls: ToolCall[]): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
    const results: Array<{ call: ToolCall; result: ToolResult }> = [];
    let parallelBatch: ToolCall[] = [];

    const flushParallelBatch = async (): Promise<void> => {
      if (parallelBatch.length === 0) return;
      const batchResults = await Promise.all(
        parallelBatch.map(async (call) => {
          const result = await this.execute(call);
          return { call, result };
        }),
      );
      results.push(...batchResults);
      parallelBatch = [];
    };

    for (const call of calls) {
      const handler = this.handlers.get(call.tool);
      const canParallel = handler?.definition.canRunInParallel ?? false;

      if (canParallel) {
        parallelBatch.push(call);
      } else {
        // Flush any pending parallel tools first, then run this sequential tool
        await flushParallelBatch();
        const result = await this.execute(call);
        results.push({ call, result });
      }
    }

    // Flush remaining parallel tools
    await flushParallelBatch();

    return results;
  }

  clearCache(toolName?: string): void {
    if (toolName) {
      // Clear only entries for this tool
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${toolName}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}
