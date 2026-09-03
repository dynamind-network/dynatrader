/**
 * Planning Tools - Following DeepAgents pattern
 * https://github.com/langchain-ai/deepagents
 *
 * The LLM decides when to use these tools based on task complexity.
 * No hardcoded heuristics - the tool descriptions guide the model.
 */

import { BaseTool } from './base-tool.js';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

interface TodoItem {
  id: string;
  task: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  reasoning?: string;
}

// Global todo storage (can be replaced with file-based persistence)
const todoStore: Map<string, TodoItem[]> = new Map();

/**
 * Write/update todos tool - following DeepAgents pattern
 */
export class WriteTodosTool extends BaseTool {
  name = 'write_todos';
  description = `Create a structured task list ONLY for complex, multi-step tasks requiring coordination.

WHEN TO USE (RARE - think carefully before using):
- Tasks requiring 5+ distinct steps across multiple systems
- Complex refactoring affecting many files
- Multi-phase operations needing checkpoint tracking

WHEN NOT TO USE (MOST CASES):
- Simple greetings (hi, hello, thanks)
- Questions answerable with text (what is X, how does Y work)
- Single tool operations (checking portfolio, reading a file, running a command)
- Tasks completable with 1-3 tool calls
- "How is my portfolio" -> Just call portfolio tool, no planning needed
- "What's the current market price" -> Just call market_data with the configured symbol, no planning needed

IMPORTANT: If a task can be done with a single tool call or direct response, do NOT use write_todos.`;

  isDestructive = false;

  inputSchema: ToolDefinition['inputSchema'] = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'List of todo items to create/update',
        items: {
          type: 'object',
          description: 'A single todo item',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the task' },
            task: { type: 'string', description: 'Description of the task' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed'],
              description: 'Current status of the task',
            },
            reasoning: { type: 'string', description: 'Why this task is needed' },
          },
          required: ['id', 'task', 'status'],
        },
      },
      conversationId: {
        type: 'string',
        description: 'Optional conversation ID to scope the todos',
      },
    },
    required: ['todos'],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const todos = input.todos as TodoItem[];
    const conversationId = (input.conversationId as string) || context.conversationId || 'default';

    todoStore.set(conversationId, todos);

    const summary = todos
      .map((t, i) => `${i + 1}. [${t.status.toUpperCase()}] ${t.task}`)
      .join('\n');

    return {
      success: true,
      output: `Plan created with ${todos.length} tasks:\n${summary}`,
    };
  }
}

/**
 * Read todos tool - following DeepAgents pattern
 */
export class ReadTodosTool extends BaseTool {
  name = 'read_todos';
  description = 'Read the current task list to check progress and plan next steps.';

  isDestructive = false;

  inputSchema: ToolDefinition['inputSchema'] = {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Optional conversation ID to scope the todos',
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const conversationId = (input.conversationId as string) || context.conversationId || 'default';
    const todos = todoStore.get(conversationId) || [];

    if (todos.length === 0) {
      return {
        success: true,
        output: 'No todos found. Use write_todos to create a task list for complex operations.',
      };
    }

    const summary = todos
      .map(
        (t, i) =>
          `${i + 1}. [${t.status.toUpperCase()}] ${t.task}${t.reasoning ? ` (${t.reasoning})` : ''}`
      )
      .join('\n');

    const stats = {
      pending: todos.filter((t) => t.status === 'pending').length,
      in_progress: todos.filter((t) => t.status === 'in_progress').length,
      completed: todos.filter((t) => t.status === 'completed').length,
      failed: todos.filter((t) => t.status === 'failed').length,
    };

    return {
      success: true,
      output: `Current task list:\n${summary}\n\nProgress: ${stats.completed}/${todos.length} completed, ${stats.in_progress} in progress`,
    };
  }
}

/**
 * Get the todo store for a conversation (for external access if needed)
 */
export function getTodoStore(conversationId: string = 'default'): TodoItem[] {
  return todoStore.get(conversationId) || [];
}

/**
 * Clear todos for a conversation
 */
export function clearTodos(conversationId: string = 'default'): void {
  todoStore.delete(conversationId);
}
