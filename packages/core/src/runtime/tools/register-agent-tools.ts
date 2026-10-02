import type { MemoryStore, ToolRegistry } from '@dyna/contracts';
import { EditTool } from './tools/edit-tool';
import { ExecTool, TaskListTool, TaskOutputTool, TaskStopTool } from './tools/exec-tool';
import { GlobTool } from './tools/glob-tool';
import { GrepTool } from './tools/grep-tool';
import { MemorySearchTool } from './tools/memory-search-tool';
import { MemoryWriteTool } from './tools/memory-write-tool';
import { ReadTool } from './tools/read-tool';
import { SessionSearchTool } from './tools/session-search-tool';
import type { SessionManager } from '@dyna/channels-core';
import type { CrossSessionRecall } from '@dyna/agent-core';
import { WebFetchTool } from './tools/web-fetch-tool';
import { WebSearchTool } from './tools/web-search-tool';
import { WriteTool } from './tools/write-tool';

/** Shared constructor wiring for tools used by the runtime and standalone CLI. */
export interface AgentToolRegistrationOptions {
  /** Explicit host mode documents the intentional stdio/runtime boundary. */
  host: 'runtime' | 'stdio';
  projectRoot: string;
  workspaceRoot: string;
  allowedDirectories?: string[];
  memoryStore?: MemoryStore;
  memoryBackend?: ConstructorParameters<typeof MemoryWriteTool>[0];
  filesystem?: boolean;
  mutations?: boolean;
  execution?: boolean;
  web?: boolean;
  sessionSearch?: boolean;
  sessionManager?: SessionManager;
  crossSessionRecall?: CrossSessionRecall;
}

/**
 * Registers shared agent tools from injected host dependencies. Tool policy
 * remains with the caller's profile/registry; this only creates handlers.
 */
export function registerAgentTools(registry: ToolRegistry, options: AgentToolRegistrationOptions): string[] {
  if (options.host === 'stdio' && (!options.allowedDirectories || options.allowedDirectories.length === 0)) {
    throw new Error('stdio tool registration requires explicit allowedDirectories');
  }
  const names: string[] = [];
  const add = (handler: Parameters<ToolRegistry['register']>[0]) => {
    registry.register(handler);
    names.push(handler.definition.name);
  };
  const allowedDirectories = options.allowedDirectories ?? [options.workspaceRoot];

  if (options.filesystem !== false) {
    add(new ReadTool({ allowedDirectories, workspaceRoot: options.workspaceRoot }));
    add(new GlobTool(allowedDirectories, options.projectRoot));
    add(new GrepTool(allowedDirectories, options.projectRoot));
    if (options.mutations !== false) {
      add(new WriteTool({ allowedDirectories, workspaceRoot: options.projectRoot }));
      add(new EditTool({ allowedDirectories, workspaceRoot: options.projectRoot }));
    }
  }

  if (options.execution) {
    const execTool = new ExecTool({ defaultCwd: options.projectRoot, workspaceRoot: options.projectRoot });
    add(execTool);
    add(new TaskOutputTool(execTool.taskManager));
    add(new TaskListTool(execTool.taskManager));
    add(new TaskStopTool(execTool.taskManager));
  }
  if (options.web) {
    add(new WebFetchTool());
    add(new WebSearchTool({
      braveApiKey: process.env.BRAVE_API_KEY,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      searxngBaseUrl: process.env.SEARXNG_BASE_URL,
    }));
  }
  if (options.memoryStore) add(new MemorySearchTool(options.memoryStore));
  if (options.memoryBackend && options.mutations !== false) add(new MemoryWriteTool(options.memoryBackend));
  if (options.sessionSearch && options.memoryStore) {
    add(new SessionSearchTool(options.memoryStore, options.sessionManager, options.crossSessionRecall));
  }

  return names;
}
