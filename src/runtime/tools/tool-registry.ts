import type {
  ToolCall,
  ToolResult,
  ToolHandler,
  ToolRegistry,
  ToolCategory,
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
  /** User message patterns that bypass cache (e.g., "refresh", "recheck") */
  cacheBypassPatterns?: string[];
}

export class ToolRegistryImpl implements ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  private auditTrail?: AuditTrail;
  private maxOutputLength: number;
  private outputArtifactDirectory: string;
  private cacheEnabled: boolean;
  private cacheTtlMs: number;
  private cacheBypassPatterns: string[];
  private cache = new Map<string, { result: ToolResult; expiresAt: number }>();

  constructor(config?: ToolRegistryConfig) {
    this.auditTrail = config?.auditTrail;
    this.maxOutputLength = config?.defaultMaxOutputLength ?? 64 * 1024;
    this.outputArtifactDirectory = config?.outputArtifactDirectory ?? path.join(process.cwd(), '.dynatrader', 'tool-results');
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
      outputArtifactDirectory: this.outputArtifactDirectory,
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

  async execute(call: ToolCall, context?: { signal?: AbortSignal }): Promise<ToolResult> {
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
      const finalResult = await this.executeInternal(call, handler, start, context);
      this.cache.set(cacheKey, { result: finalResult, expiresAt: Date.now() + this.cacheTtlMs });
      return JSON.parse(JSON.stringify(finalResult));
    }

    return this.executeInternal(call, handler, start, context);
  }

  private async executeInternal(call: ToolCall, handler: ToolHandler, start: number, context?: { signal?: AbortSignal }): Promise<ToolResult> {
    const timeout = handler.definition.timeoutMs;

    let result: ToolResult;

    try {
      const executionPromise = handler.execute(call, context);
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
