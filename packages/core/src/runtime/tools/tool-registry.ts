import type {
  ToolCall,
  ToolResult,
  ToolHandler,
  ToolRegistry,
  ToolCategory,
  ToolExecutionContext,
} from '@dyna/contracts';
import type { AuditTrail } from '@dyna/audit';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ToolRegistryConfig {
  auditTrail?: AuditTrail;
  defaultMaxOutputLength?: number;
  /** Workspace-local directory for complete tool results that exceed the inline limit. */
  outputArtifactDirectory?: string;
  /** Enable caching for read-only tools. Default: false */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds. Default: 300_000 (5 min) */
  cacheTtlMs?: number;
  /** Maximum number of successful read-only results retained by this registry. Default: 500. */
  cacheMaxEntries?: number;
  /** Per-tool TTL overrides. Tools still need readOnly=true and no declared side effects. */
  cacheTtlByTool?: Record<string, number>;
  /** Additional identity scope for results that vary by user/account/tenant. */
  cacheScope?: (call: ToolCall, context?: ToolExecutionContext) => string | undefined;
  /** User message patterns that bypass cache (e.g., "refresh", "recheck") */
  cacheBypassPatterns?: string[];
}

export interface ToolCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  evictions: number;
  entries: number;
}

export class ToolRegistryImpl implements ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  private auditTrail?: AuditTrail;
  private maxOutputLength: number;
  private outputArtifactDirectory: string;
  private cacheEnabled: boolean;
  private cacheTtlMs: number;
  private cacheMaxEntries: number;
  private cacheTtlByTool: Record<string, number>;
  private cacheScope?: ToolRegistryConfig['cacheScope'];
  private cacheBypassPatterns: string[];
  private cache = new Map<string, { result: ToolResult; expiresAt: number }>();
  private inFlight = new Map<string, Promise<ToolResult>>();
  private cacheStats: Omit<ToolCacheStats, 'entries'> = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };

  constructor(config?: ToolRegistryConfig) {
    this.auditTrail = config?.auditTrail;
    this.maxOutputLength = config?.defaultMaxOutputLength ?? 64 * 1024;
    this.outputArtifactDirectory = config?.outputArtifactDirectory ?? path.join(process.cwd(), '.dynatrader', 'tool-results');
    this.cacheEnabled = config?.cacheEnabled ?? false;
    this.cacheTtlMs = config?.cacheTtlMs ?? 300_000;
    this.cacheMaxEntries = Math.max(0, config?.cacheMaxEntries ?? 500);
    this.cacheTtlByTool = config?.cacheTtlByTool ?? {};
    this.cacheScope = config?.cacheScope;
    this.cacheBypassPatterns = config?.cacheBypassPatterns ?? ['refresh', 'recheck', 'reload', 'update'];
  }

  register(handler: ToolHandler): void {
    this.clearCache(handler.definition.name);
    this.handlers.set(handler.definition.name, handler);
  }

  unregister(name: string): boolean {
    this.clearCache(name);
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
      outputArtifactDirectory: this.outputArtifactDirectory,
      cacheEnabled: this.cacheEnabled,
      cacheTtlMs: this.cacheTtlMs,
      cacheMaxEntries: this.cacheMaxEntries,
      cacheTtlByTool: this.cacheTtlByTool,
      cacheScope: this.cacheScope,
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

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
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

    const cacheKey = this.getCacheKey(call, handler, context);
    if (cacheKey) {
      const now = Date.now();
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        this.cacheStats.hits++;
        // Refresh LRU order, and return a detached copy to prevent callers mutating the entry.
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        await this.recordCacheAccess(call, 'hit');
        return this.cloneResult(cached.result);
      }
      if (cached) this.cache.delete(cacheKey);

      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        this.cacheStats.coalesced++;
        const result = await pending;
        await this.recordCacheAccess(call, 'coalesced');
        return this.cloneResult(result);
      }

      this.cacheStats.misses++;
      const execution = this.executeInternal(call, handler, start, context);
      this.inFlight.set(cacheKey, execution);
      try {
        const result = await execution;
        // Cache only plain successful values. Artifact references, outputs with side channels,
        // and truncated results can contain call-specific data or become stale independently.
        if (result.success && !result.truncated && result.artifacts === undefined && result.stdout === undefined && result.stderr === undefined) {
          this.putCache(cacheKey, result, this.cacheTtlByTool[call.tool] ?? this.cacheTtlMs);
        }
        return this.cloneResult(result);
      } finally {
        if (this.inFlight.get(cacheKey) === execution) this.inFlight.delete(cacheKey);
      }
    }

    return this.executeInternal(call, handler, start, context);
  }

  private async executeInternal(call: ToolCall, handler: ToolHandler, start: number, context?: ToolExecutionContext): Promise<ToolResult> {
    const timeout = handler.definition.timeoutMs;
    let result: ToolResult;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
      if (context?.signal?.aborted) {
        throw new Error(`Tool '${call.tool}' cancelled before execution`);
      }
      const abortPromise = new Promise<never>((_, reject) => {
        const abort = () => {
          const reason = context?.signal?.reason;
          reject(new Error(`Tool '${call.tool}' cancelled${reason instanceof Error ? `: ${reason.message}` : ''}`));
          controller.abort(reason);
        };
        context?.signal?.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => context?.signal?.removeEventListener('abort', abort);
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`Tool '${call.tool}' timed out after ${timeout}ms`);
          reject(error);
          controller.abort(error);
        }, timeout);
      });

      const executionPromise = handler.execute(call, { ...context, signal: controller.signal });
      result = await Promise.race([executionPromise, timeoutPromise, abortPromise]);
    } catch (err) {
      result = {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      removeAbortListener?.();
    }

    const durationMs = Date.now() - start;

    let truncated = result.truncated;
    let finalData = result.data;
    let finalStdout = result.stdout;
    let finalStderr = result.stderr;
    let finalError = result.error;

    const fullOutput = {
      data: result.data,
      artifacts: result.artifacts,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
    const serializedOutput = JSON.stringify(fullOutput);
    const outputBytes = Buffer.byteLength(serializedOutput, 'utf8');
    let outputArtifactId: string | undefined;

    if (outputBytes > this.maxOutputLength) {
      const callId = call.id ?? randomUUID();
      const artifactId = randomUUID();
      const filename = `${artifactId}.txt`;
      const artifactPath = path.join(this.outputArtifactDirectory, filename);
      const artifactContents = [
        `Tool: ${call.tool}`,
        `Tool call ID: ${callId}`,
        `Full result size: ${outputBytes} bytes`,
        '',
        'Full, untruncated tool result (JSON):',
        JSON.stringify(fullOutput, null, 2),
        '',
      ].join('\n');

      try {
        await mkdir(this.outputArtifactDirectory, { recursive: true });
        await writeFile(artifactPath, artifactContents, { encoding: 'utf8', flag: 'wx' });
        outputArtifactId = artifactId;
        const readPath = path.relative(process.cwd(), artifactPath).split(path.sep).join('/');
        const reference = `Complete tool result saved to ${readPath} (artifact ${artifactId}, tool call ${callId}, ${outputBytes} bytes). Read this file with the read tool for the full output.`;
        finalData = reference;
        finalStdout = undefined;
        finalStderr = undefined;
        finalError = result.error === undefined ? undefined : reference;
        truncated = true;
      } catch (error) {
        // Preserve the previous bounded behavior if local artifact storage is unavailable.
        finalData = `Tool output exceeded the ${this.maxOutputLength}-byte inline limit and could not be saved: ${(error as Error).message}`;
        finalStdout = undefined;
        finalStderr = undefined;
        finalError = String(finalData);
        truncated = true;
      }
    }

    const finalResult: ToolResult = {
      success: result.success,
      durationMs,
      truncated,
    };

    if (finalError !== undefined) {
      finalResult.error = finalError;
    }
    if (finalData !== undefined) {
      finalResult.data = finalData;
    }
    if (finalStdout !== undefined) {
      finalResult.stdout = finalStdout;
    }
    if (finalStderr !== undefined) {
      finalResult.stderr = finalStderr;
    }
    if (result.artifacts !== undefined) {
      finalResult.artifacts = result.artifacts;
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
          outputArtifactId,
        },
      });
    }

    return finalResult;
  }

  /**
   * Execute multiple tool calls. Tools with canRunInParallel=true run concurrently.
   * Tools without it run sequentially in order.
   */
  async executeBatch(calls: ToolCall[], context?: ToolExecutionContext): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
    const results: Array<{ call: ToolCall; result: ToolResult }> = [];
    let parallelBatch: ToolCall[] = [];

    const flushParallelBatch = async (): Promise<void> => {
      if (parallelBatch.length === 0) return;
      const batchResults = await Promise.all(
        parallelBatch.map(async (call) => {
          const result = await this.execute(call, context);
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
        const result = await this.execute(call, context);
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
        if (key.startsWith(`${toolName}\u0000`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /** Snapshot cache counters for runtime diagnostics. Counters reset only when this registry is recreated. */
  getCacheStats(): ToolCacheStats {
    return { ...this.cacheStats, entries: this.cache.size };
  }

  private getCacheKey(call: ToolCall, handler: ToolHandler, context?: ToolExecutionContext): string | undefined {
    const definition = handler.definition;
    // readOnly alone is not sufficient: a tool declaring any side effect is never cacheable.
    if (!this.cacheEnabled || this.cacheMaxEntries === 0 || definition.readOnly !== true || (definition.sideEffects?.length ?? 0) > 0) return;
    // A shared in-flight request must not inherit one caller's cancellation signal.
    if (context?.signal || context?.approvalGranted) return;
    const ttl = this.cacheTtlByTool[call.tool] ?? this.cacheTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    let argsKey: string;
    try {
      argsKey = stableSerialize(call.args);
    } catch {
      return;
    }
    const searchable = argsKey.toLowerCase();
    if (this.cacheBypassPatterns.some((pattern) => pattern && searchable.includes(pattern.toLowerCase()))) return;
    let scope: string | undefined;
    try {
      scope = this.cacheScope ? this.cacheScope(call, context) : 'registry';
    } catch {
      return;
    }
    // Undefined means the caller cannot establish a safe identity boundary.
    if (scope === undefined) return;
    return `${call.tool}\u0000${scope}\u0000${argsKey}`;
  }

  private putCache(key: string, result: ToolResult, ttlMs: number): void {
    if (ttlMs <= 0 || this.cacheMaxEntries === 0) return;
    this.cache.delete(key);
    this.cache.set(key, { result: this.cloneResult(result), expiresAt: Date.now() + ttlMs });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.cacheStats.evictions++;
    }
  }

  private cloneResult(result: ToolResult): ToolResult {
    return JSON.parse(JSON.stringify(result)) as ToolResult;
  }

  private async recordCacheAccess(call: ToolCall, cache: 'hit' | 'coalesced'): Promise<void> {
    if (!this.auditTrail) return;
    await this.auditTrail.record({
      type: 'tool_call',
      actor: 'system',
      actorType: 'tool',
      action: `tool_execute:${call.tool}`,
      resource: call.tool,
      result: 'success',
      details: { args: call.args, correlationId: call.correlationId, cache },
    });
  }
}

/** Stable JSON key serialization: object key order is normalized recursively; array order is preserved. */
function stableSerialize(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) {
        throw new TypeError('Unsupported cache key value');
      }
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Non-finite cache key number');
      return item;
    }
    if (ancestors.has(item)) throw new TypeError('Circular cache key value');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(normalize);
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Non-plain cache key object');
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) normalized[key] = normalize((item as Record<string, unknown>)[key]);
      return normalized;
    } finally {
      ancestors.delete(item);
    }
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new TypeError('Unsupported cache key value');
  return serialized;
}
