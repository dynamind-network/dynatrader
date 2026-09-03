import { promises as fs } from 'fs';
import path from 'path';
import { DYNAMIND_DIR } from '../utils/constants.js';
import type { Task } from './task-queue.js';
import type { AgentEvent, ToolExecutionContext } from '../core/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { SubagentRegistry, executeSpawnedAgent } from '../agents/subagent.js';
import { getErrorMessage } from '../utils/index.js';
import { parseJson } from '../utils/json.js';

export interface SpawnedAgentEvent {
  type: 'started' | 'tool_call' | 'text' | 'completed' | 'failed';
  taskId: string;
  presetName: string;
  content?: string;
  toolName?: string;
  result?: string;
  error?: string;
  timestamp: Date;
}

export interface TaskExecutorOpts {
  apiKeys: Record<string, string>;
  model: string;
  subagentRegistry: SubagentRegistry;
  toolRegistry: ToolRegistry;
  resultsDir?: string;
  onEvent?: (event: SpawnedAgentEvent) => void;
}

export class TaskExecutor {
  private apiKeys: Record<string, string>;
  private model: string;
  private subagentRegistry: SubagentRegistry;
  private toolRegistry: ToolRegistry;
  private resultsDir: string;
  private onEvent?: (event: SpawnedAgentEvent) => void;

  constructor(options: TaskExecutorOpts) {
    this.apiKeys = options.apiKeys;
    this.model = options.model;
    this.subagentRegistry = options.subagentRegistry;
    this.toolRegistry = options.toolRegistry;
    this.resultsDir = options.resultsDir || path.join(DYNAMIND_DIR, 'agent-results');
    this.onEvent = options.onEvent;
  }

  async execute(task: Task): Promise<string> {
    const presetName = task.payload.agentName;
    const taskDescription = task.payload.task || task.payload.userRequest;

    if (!presetName) {
      throw new Error('Task payload must contain agentName for spawned agent execution');
    }
    if (!taskDescription) {
      throw new Error('Task payload must contain task or userRequest');
    }

    const definition = this.subagentRegistry.get(presetName);
    if (!definition) {
      throw new Error(
        `Unknown preset: ${presetName}. Available: ${this.subagentRegistry.getNames().join(', ')}`
      );
    }

    this.emitEvent({
      type: 'started',
      taskId: task.id,
      presetName,
      timestamp: new Date(),
    });

    try {
      const context: ToolExecutionContext = {
        workingDirectory: (task.payload.context?.cwd as string) || process.cwd(),
        conversationId: task.id,
        isSubagent: true,
      };

      const result = await executeSpawnedAgent({
        apiKeys: this.apiKeys,
        model: this.model,
        presetName,
        definition,
        task: taskDescription,
        toolRegistry: this.toolRegistry,
        context,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'text') {
            this.emitEvent({
              type: 'text',
              taskId: task.id,
              presetName,
              content: event.content,
              timestamp: new Date(),
            });
          } else if (event.type === 'tool_start') {
            this.emitEvent({
              type: 'tool_call',
              taskId: task.id,
              presetName,
              toolName: event.toolName,
              timestamp: new Date(),
            });
          }
        },
      });

      await this.persistResult(task.id, presetName, 'completed', result);
      this.emitEvent({
        type: 'completed',
        taskId: task.id,
        presetName,
        result,
        timestamp: new Date(),
      });

      return result;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      await this.persistResult(task.id, presetName, 'failed', undefined, errorMessage);
      this.emitEvent({
        type: 'failed',
        taskId: task.id,
        presetName,
        error: errorMessage,
        timestamp: new Date(),
      });
      throw new Error(`Agent preset ${presetName} failed: ${errorMessage}`, { cause: error });
    }
  }

  private async persistResult(
    taskId: string,
    presetName: string,
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<string> {
    await fs.mkdir(this.resultsDir, { recursive: true });

    const resultPath = path.join(this.resultsDir, `${taskId}.json`);
    const data = {
      taskId,
      presetName,
      status,
      result: result || null,
      error: error || null,
      completedAt: new Date().toISOString(),
    };

    await fs.writeFile(resultPath, JSON.stringify(data, null, 2));
    return resultPath;
  }

  async readResult(taskId: string): Promise<{
    taskId: string;
    presetName: string;
    status: 'completed' | 'failed';
    result: string | null;
    error: string | null;
    completedAt: string;
  } | null> {
    const resultPath = path.join(this.resultsDir, `${taskId}.json`);
    try {
      const content = await fs.readFile(resultPath, 'utf-8');
      return parseJson(content) ?? null;
    } catch {
      return null;
    }
  }

  getResultsDir(): string {
    return this.resultsDir;
  }

  private emitEvent(event: SpawnedAgentEvent): void {
    this.onEvent?.(event);
  }
}

export default TaskExecutor;
