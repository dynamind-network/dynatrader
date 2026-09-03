import type { Task } from './task-queue.js';
import type { AgentConfig, ToolExecutionContext } from '../core/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { AgentLoop } from '../core/agent-loop.js';
import { getErrorMessage } from '../utils/index.js';

export class AgentTaskExecutor {
  private apiKeys: Record<string, string>;
  private defaultConfig: AgentConfig;
  private toolRegistry: ToolRegistry;

  constructor(
    apiKeys: Record<string, string>,
    defaultConfig: AgentConfig,
    toolRegistry: ToolRegistry
  ) {
    this.apiKeys = apiKeys;
    this.defaultConfig = defaultConfig;
    this.toolRegistry = toolRegistry;
  }

  async execute(task: Task): Promise<unknown> {
    const userRequest = task.payload.userRequest;

    if (!userRequest) {
      throw new Error('Task payload must contain userRequest');
    }

    try {
      const agentLoop = new AgentLoop(this.apiKeys, this.defaultConfig, this.toolRegistry);

      const context: ToolExecutionContext = {
        workingDirectory: (task.payload.context?.cwd as string) || process.cwd(),
        conversationId: task.id,
        isSubagent: true,
      };

      const response = await agentLoop.run(userRequest, context);
      return response;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Task execution failed: ${errorMessage}`, { cause: error });
    }
  }

  async executeBatch(tasks: Task[]): Promise<unknown[]> {
    const results: unknown[] = [];

    for (const task of tasks) {
      try {
        const result = await this.execute(task);
        results.push(result);
      } catch (error) {
        results.push({
          error: getErrorMessage(error),
        });
      }
    }

    return results;
  }
}

export default AgentTaskExecutor;
