import { promises as fs } from 'fs';
import path from 'path';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { BaseTool } from './base-tool.js';
import { PathSecurity } from './path-security.js';
import { getErrorMessage } from '../utils/index.js';
import { parseJson } from '../utils/json.js';

import { DYNAMIND_DIR } from '../utils/constants.js';

const DEFAULT_RESULTS_DIR = path.join(DYNAMIND_DIR, 'agent-results');

function resolveTrustedResultsDir(resultsDir: string, workingDirectory: string): string {
  const trimmed = resultsDir.trim();
  if (!trimmed) {
    throw new Error('Results directory cannot be empty');
  }

  const hasNullByte = trimmed.includes('\0');
  if (hasNullByte) {
    throw new Error('Results directory contains invalid null bytes');
  }

  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  return PathSecurity.resolveWithinWorkspace(trimmed, workingDirectory);
}

export interface AgentResultData {
  taskId: string;
  presetName: string;
  status: 'completed' | 'failed';
  result: string | null;
  error: string | null;
  completedAt: string;
}

export class ReadAgentResultTool extends BaseTool {
  name = 'read_agent_result';
  description = `Read the result of a completed background spawned agent task.
Use this after calling spawn_agent with execution_mode="async".

Returns the spawned agent's output if completed, or status info if still running.`;

  isDestructive = false;

  inputSchema = {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID returned when the agent was spawned',
      },
    },
    required: ['task_id'],
  };

  constructor(private resultsDir: string = DEFAULT_RESULTS_DIR) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const taskId = input.task_id as string;

    if (!taskId || typeof taskId !== 'string') {
      return this.error('Invalid task_id: must be a non-empty string');
    }

    let resultsPath: string;
    try {
      resultsPath = resolveTrustedResultsDir(this.resultsDir, context.workingDirectory);
    } catch (err) {
      return this.error(`Invalid results directory: ${getErrorMessage(err)}`);
    }

    const resultFilePath = path.join(resultsPath, `${taskId}.json`);

    try {
      const content = await fs.readFile(resultFilePath, 'utf-8');
      const data = parseJson<AgentResultData>(content);

      if (!data) {
        return this.error(`Failed to parse result file for task ${taskId}`);
      }

      if (data.status === 'failed') {
        return this.error(
          `Agent preset '${data.presetName}' failed: ${data.error}\nCompleted at: ${data.completedAt}`
        );
      }

      return this.success(
        `[${data.presetName} completed at ${data.completedAt}]\n\n${data.result}`
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.error(
          `Task ${taskId} not found. It may still be running or the ID is incorrect.\nUse list_agent_results to inspect recent tasks.`
        );
      }
      return this.error(`Failed to read result: ${getErrorMessage(err)}`);
    }
  }

  setResultsDir(dir: string): void {
    this.resultsDir = dir;
  }
}

export class ListAgentResultsTool extends BaseTool {
  name = 'list_agent_results';
  description = `List all available spawned-agent task results.
Shows task IDs, preset names, status, and completion times.`;

  isDestructive = false;

  inputSchema = {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status: completed, failed, or all',
        enum: ['completed', 'failed', 'all'],
        default: 'all',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 20,
      },
    },
    required: [],
  };

  constructor(private resultsDir: string = DEFAULT_RESULTS_DIR) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const statusFilter = (input.status as string) || 'all';
    const limit = (input.limit as number) || 20;

    let resultsPath: string;
    try {
      resultsPath = resolveTrustedResultsDir(this.resultsDir, context.workingDirectory);
    } catch (err) {
      return this.error(`Invalid results directory: ${getErrorMessage(err)}`);
    }

    try {
      const files = await fs.readdir(resultsPath);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const results: AgentResultData[] = [];
      for (const file of jsonFiles.slice(0, limit * 2)) {
        try {
          const content = await fs.readFile(path.join(resultsPath, file), 'utf-8');
          const data = parseJson<AgentResultData>(content);
          if (data && (statusFilter === 'all' || data.status === statusFilter)) {
            results.push(data);
          }
        } catch {
          // Ignore unreadable files.
        }
      }

      results.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

      const limited = results.slice(0, limit);
      if (limited.length === 0) {
        return this.success('No agent results found.');
      }

      const output = limited
        .map(
          (result) =>
            `[${result.taskId.slice(0, 8)}] ${result.presetName} - ${result.status} (${result.completedAt})`
        )
        .join('\n');

      return this.success(`Agent Results (${limited.length}/${results.length}):\n\n${output}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.success('No agent results found. Results directory does not exist.');
      }
      return this.error(`Failed to list results: ${getErrorMessage(err)}`);
    }
  }

  setResultsDir(dir: string): void {
    this.resultsDir = dir;
  }
}

export default ReadAgentResultTool;
