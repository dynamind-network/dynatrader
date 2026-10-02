import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolHandler, ToolResult } from '@dyna/contracts';
import type { ReplExecutionOutput, NodeReplService, PythonReplService } from '../../repl/session-runtime.js';

const MAX_SOURCE_CHARS = 100_000;
const MAX_RESULT_CHARS = 32_000;

type ReplExecutor = Pick<NodeReplService | PythonReplService, 'execute'>;

abstract class ReplTool implements ToolHandler {
  abstract readonly definition: ToolDefinition;

  protected constructor(private readonly service: ReplExecutor) {}

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const started = Date.now();
    const sessionId = context?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { success: false, error: 'A conversation sessionId is required for persistent REPL execution.', durationMs: 0, truncated: false };
    }
    const source = call.args.code;
    if (typeof source !== 'string' || !source.trim()) {
      return { success: false, error: 'code must be a non-empty string.', durationMs: 0, truncated: false };
    }
    if (source.length > MAX_SOURCE_CHARS) {
      return { success: false, error: `code exceeds the ${MAX_SOURCE_CHARS}-character limit.`, durationMs: 0, truncated: false };
    }

    try {
      const output = await this.service.execute(sessionId, source, context?.signal);
      return formatOutput(output, Date.now() - started);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        truncated: false,
      };
    }
  }
}

export class NodeReplTool extends ReplTool {
  readonly definition: ToolDefinition = {
    name: 'node_repl',
    description: 'Execute general-purpose JavaScript in the persistent Node.js REPL for this conversation. The configured runtime determines its isolation and host access.',
    category: 'exec',
    inputSchema: { code: 'string' },
    outputSchema: { value: 'any', stdout: 'string?', stderr: 'string?' },
    permissionsRequired: ['tool.node_repl'],
    sideEffects: ['code_execution'],
    riskLevel: 'critical',
    timeoutMs: 35_000,
  };

  constructor(service: Pick<NodeReplService, 'execute'>) { super(service); }
}

export class PythonReplTool extends ReplTool {
  readonly definition: ToolDefinition = {
    name: 'python_repl',
    description: 'Execute general-purpose Python in the persistent Python REPL for this conversation. The configured runtime determines its isolation and host access.',
    category: 'exec',
    inputSchema: { code: 'string' },
    outputSchema: { value: 'any', stdout: 'string?', stderr: 'string?' },
    permissionsRequired: ['tool.python_repl'],
    sideEffects: ['code_execution'],
    riskLevel: 'critical',
    timeoutMs: 35_000,
  };

  constructor(service: Pick<PythonReplService, 'execute'>) { super(service); }
}

function formatOutput(output: ReplExecutionOutput, durationMs: number): ToolResult {
  let remaining = MAX_RESULT_CHARS;
  let truncated = output.truncated;
  const take = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (value.length <= remaining) {
      remaining -= value.length;
      return value;
    }
    truncated = true;
    const part = value.slice(0, remaining);
    remaining = 0;
    return part;
  };

  const stdout = take(output.stdout);
  const stderr = take(output.stderr);
  let value = output.value;
  if (value !== undefined) {
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? String(value); }
    catch { serialized = '[unserializable REPL result]'; }
    if (serialized.length > remaining) {
      truncated = true;
      value = serialized.slice(0, remaining);
    }
  }

  return {
    success: true,
    data: value === undefined ? undefined : { value },
    stdout,
    stderr,
    durationMs,
    truncated,
  };
}
