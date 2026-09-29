import type { SubagentDefinition, ToolExecutionContext, AgentEvent } from '../core/types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentLoop } from '../core/agent-loop.js';
import { getErrorMessage } from '../utils/index.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { BaseTool } from '../tools/base-tool.js';
import { AgentLoader } from './agent-loader.js';
import { DYNAMIND_DIR } from '../utils/constants.js';
import {
  ListAgentResultsTool,
  ReadAgentResultTool,
  type AgentResultData,
} from '../tools/subagent-result.js';

type SubagentRegistryOptions =
  | string
  | {
      projectDir?: string;
      projectDirs?: string[];
      globalDir?: string;
      globalDirs?: string[];
    };

export class SubagentRegistry {
  private subagents = new Map<string, SubagentDefinition>();
  private agentLoader: AgentLoader;
  private initialized = false;

  constructor(options?: SubagentRegistryOptions) {
    this.agentLoader = new AgentLoader(options);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.agentLoader.discoverAndLoad();

    this.initialized = true;
  }

  register(definition: SubagentDefinition): void {
    this.subagents.set(definition.name, definition);
  }

  get(name: string): SubagentDefinition | undefined {
    const fileAgent = this.agentLoader.getAgent(name);
    if (fileAgent && fileAgent.frontmatter.enabled && fileAgent.frontmatter.mode?.subagent) {
      const maxTurns = fileAgent.frontmatter.agent?.maxTurns;
      if (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns) || maxTurns <= 0) {
        throw new Error(
          `Agent ${fileAgent.id} is missing agent.maxTurns in its frontmatter. Set it explicitly in the agent file or workspace defaults.`
        );
      }

      return {
        name: fileAgent.id,
        description: fileAgent.frontmatter.description || '',
        systemPrompt: fileAgent.body,
        tools: fileAgent.frontmatter.tools || [],
        maxTurns,
        canSpawnSubagents: fileAgent.frontmatter.agent?.canSpawnSubagents || false,
      };
    }

    return this.subagents.get(name);
  }

  getNames(): string[] {
    const fileNames = this.agentLoader.getVisibleByMode('subagent').map((a) => a.id);
    const hiddenFileNames = new Set(
      this.agentLoader
        .getByMode('subagent')
        .filter((a) => a.frontmatter.hidden)
        .map((a) => a.id)
    );
    const defaultNames = Array.from(this.subagents.values())
      .filter((agent) => !agent.hidden && !hiddenFileNames.has(agent.name))
      .map((agent) => agent.name);
    return [...new Set([...fileNames, ...defaultNames])];
  }

  getVisible(): SubagentDefinition[] {
    const visibleNames = new Set(this.getNames());
    const fileAgents = this.agentLoader.getVisibleByMode('subagent').map((a) => ({
      name: a.id,
      description: a.frontmatter.description || '',
      systemPrompt: a.body,
      tools: a.frontmatter.tools || [],
      maxTurns: (() => {
        const maxTurns = a.frontmatter.agent?.maxTurns;
        if (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns) || maxTurns <= 0) {
          throw new Error(
            `Agent ${a.id} is missing agent.maxTurns in its frontmatter. Set it explicitly in the agent file or workspace defaults.`
          );
        }
        return maxTurns;
      })(),
      canSpawnSubagents: a.frontmatter.agent?.canSpawnSubagents || false,
    }));

    const defaultAgentDefs = Array.from(this.subagents.values()).filter((agent) =>
      visibleNames.has(agent.name)
    );

    return [...fileAgents, ...defaultAgentDefs].filter((agent) => visibleNames.has(agent.name));
  }

  getAgentEntries(): Array<{
    name: string;
    description: string;
    source: 'workspace' | 'runtime';
    hidden: boolean;
    enabled: boolean;
  }> {
    const fileAgents = this.agentLoader.getByMode('subagent');
    const fileNames = new Set(fileAgents.map((agent) => agent.id));

    const entries: Array<{
      name: string;
      description: string;
      source: 'workspace' | 'runtime';
      hidden: boolean;
      enabled: boolean;
    }> = fileAgents.map((agent) => ({
      name: agent.id,
      description: agent.frontmatter.description || '',
      source: 'workspace',
      hidden: Boolean(agent.frontmatter.hidden),
      enabled: Boolean(agent.frontmatter.enabled),
    }));

    for (const agent of this.subagents.values()) {
      if (agent.hidden) continue;
      if (fileNames.has(agent.name)) continue;
      entries.push({
        name: agent.name,
        description: agent.description,
        source: 'runtime',
        hidden: false,
        enabled: true,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.agentLoader.getAgent(name) !== undefined || this.subagents.has(name);
  }

  getAgentLoader(): AgentLoader {
    return this.agentLoader;
  }
}

export interface SpawnAgentInputSchema {
  type: 'object';
  properties: {
    preset: {
      type: 'string';
      description: string;
      enum: string[];
    };
    task: {
      type: 'string';
      description: string;
    };
    execution_mode: {
      type: 'string';
      description: string;
      enum: ['sync', 'async'];
    };
  };
  required: string[];
}

export interface SpawnedAgentOpts {
  apiKeys: Record<string, string>;
  model: string;
  presetName: string;
  definition: SubagentDefinition;
  task: string;
  toolRegistry: ToolRegistry;
  context: ToolExecutionContext;
  onEvent?: (event: AgentEvent) => void;
}

export async function executeSpawnedAgent(options: SpawnedAgentOpts): Promise<string> {
  const { apiKeys, model, presetName, definition, task, toolRegistry, context, onEvent } = options;

  if (!apiKeys || Object.keys(apiKeys).length === 0) {
    throw new Error('No API keys configured for spawned agent execution');
  }

  const spawnedToolRegistry = new ToolRegistry();
  for (const toolName of definition.tools) {
    const tool = toolRegistry.get(toolName);
    if (tool) {
      spawnedToolRegistry.register(tool);
    } else {
      console.warn(`[SpawnAgentTool] Tool ${toolName} not found for preset ${presetName}`);
    }
  }

  const spawnedAgentLoop = new AgentLoop(
    apiKeys,
    {
      model,
      systemPrompt: definition.systemPrompt,
      maxTokens: 4096,
      maxTurns: definition.maxTurns,
      tools: definition.tools,
    },
    spawnedToolRegistry,
    {
      onEvent: (event) => {
        if (event.type === 'text') {
          onEvent?.({
            type: 'text',
            content: `[${presetName}] ${event.content}`,
          });
          return;
        }

        onEvent?.(event);
      },
    }
  );

  const agentDepth = (context.agentDepth ?? 0) + 1;
  return spawnedAgentLoop.run(task, {
    ...context,
    isSubagent: true,
    agentDepth,
  });
}

export class SpawnAgentTool extends BaseTool {
  name = 'spawn_agent';
  description = '';
  isDestructive = false;

  inputSchema: SpawnAgentInputSchema = {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        description: 'Optional named agent preset to use',
        enum: [],
      },
      task: {
        type: 'string',
        description: 'Detailed description of the task for the spawned agent',
      },
      execution_mode: {
        type: 'string',
        description:
          'How to run the spawned agent: "sync" waits for completion, "async" returns immediately with a task ID',
        enum: ['sync', 'async'],
      },
    },
    required: ['task'],
  };

  private apiKeys: Record<string, string>;
  private model: string;
  private subagentRegistry: SubagentRegistry;
  private toolRegistry: ToolRegistry;
  private onEvent?: (event: AgentEvent) => void;
  private currentDepth: number;
  private maxDepth: number;
  private initialized = false;
  private resultsDir: string;

  constructor(options: {
    apiKey?: string;
    apiKeys?: Record<string, string>;
    model: string;
    subagentRegistry: SubagentRegistry;
    toolRegistry: ToolRegistry;
    onEvent?: (event: AgentEvent) => void;
    currentDepth?: number;
    maxDepth?: number;
    resultsDir?: string;
  }) {
    super();
    if (options.apiKeys) {
      this.apiKeys = options.apiKeys;
    } else if (options.apiKey) {
      this.apiKeys = { anthropic: options.apiKey };
    } else {
      this.apiKeys = {};
    }
    this.model = options.model;
    this.subagentRegistry = options.subagentRegistry;
    this.toolRegistry = options.toolRegistry;
    this.onEvent = options.onEvent;
    this.currentDepth = options.currentDepth || 0;
    this.maxDepth = options.maxDepth || 2;
    this.resultsDir = options.resultsDir || path.join(DYNAMIND_DIR, 'agent-results');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.subagentRegistry.initialize();
    const presets = this.subagentRegistry.getVisible();
    this.inputSchema.properties.preset.enum = presets.map((preset) => preset.name);

    if (presets.length === 0) {
      this.description = 'Spawn a specialized agent from a configured preset.';
    } else {
      const descriptions = presets.map((preset) => `- \`${preset.name}\`: ${preset.description}`);
      this.description = `Spawn a specialized agent using a configured preset.

Available presets:
${descriptions.join('\n')}`;
    }

    this.initialized = true;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ success: boolean; output: string }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const presetName = typeof input.preset === 'string' ? input.preset.trim() : '';
    const task = input.task as string;
    const executionMode = (input.execution_mode as string) || 'sync';

    if (!presetName) {
      const availablePresets = this.subagentRegistry.getNames();
      return this.error(
        availablePresets.length > 0
          ? `Invalid preset: must be a non-empty string. Available: ${availablePresets.join(', ')}`
          : 'Invalid preset: no subagent presets are configured'
      );
    }
    if (!task || typeof task !== 'string') {
      return this.error('Invalid task: must be a non-empty string');
    }
    if (executionMode !== 'sync' && executionMode !== 'async') {
      return this.error('Invalid execution_mode: must be "sync" or "async"');
    }
    const currentDepth = context.agentDepth ?? this.currentDepth;
    if (currentDepth >= this.maxDepth) {
      return this.error('Cannot spawn agent: maximum nesting depth reached.');
    }

    const definition = this.subagentRegistry.get(presetName);
    if (!definition) {
      return this.error(
        `Unknown preset: ${presetName}. Available: ${this.subagentRegistry.getNames().join(', ')}`
      );
    }
    if (!definition.canSpawnSubagents && currentDepth > 0) {
      return this.error(`Preset ${presetName} cannot be called from another agent`);
    }

    this.onEvent?.({
      type: 'text',
      content: `[Spawning ${presetName} agent...]`,
    });

    if (executionMode === 'async') {
      const taskId = randomUUID();
      this.emitActivity(taskId, presetName, 'Started in background.', 'running');
      void this.runAgentTask(taskId, presetName, task, definition, context);
      return this.success(
        `Agent ${presetName} started in background.\nTask ID: ${taskId}\nUse read_agent_result with this task ID to fetch the result.`
      );
    }

    const maxRetries = 2;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const taskId = randomUUID();
        this.emitActivity(taskId, presetName, 'Started.', 'running');
        const result = await this.executeSubagent(taskId, presetName, task, definition, context);

        if (!result) {
          throw new Error('Spawned agent returned empty result');
        }

        this.emitActivity(taskId, presetName, result, 'completed');
        return this.success(`[${presetName} completed]\n\n${result}`);
      } catch (err) {
        const message = getErrorMessage(err);
        console.error(`[SpawnAgentTool] Attempt ${attempt} failed for ${presetName}:`, message);

        const isRetryable =
          err instanceof Error &&
          /(network|timeout|rate limit|connection|fetch|temporary)/i.test(err.message);

        if (attempt === maxRetries || !isRetryable) {
          return this.error(
            `Agent ${presetName} failed after ${attempt} attempt${attempt > 1 ? 's' : ''}: ${message}`
          );
        }

        this.onEvent?.({
          type: 'text',
          content: `[${presetName}] Attempt ${attempt} failed, retrying... (${message})`,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }

    return this.error(`Agent ${presetName} failed: Maximum retries exceeded`);
  }

  private async executeSubagent(
    taskId: string,
    presetName: string,
    task: string,
    definition: SubagentDefinition,
    context: ToolExecutionContext
  ): Promise<string> {
    return executeSpawnedAgent({
      apiKeys: this.apiKeys,
      model: this.model,
      presetName,
      definition,
      task,
      toolRegistry: this.toolRegistry,
      context,
      onEvent: (event) => {
        let activity = '';
        if (event.type === 'text') activity = event.content;
        else if (event.type === 'tool_start') activity = `Running ${event.toolName}`;
        else if (event.type === 'tool_end') activity = `${event.result.success ? 'Completed' : 'Failed'} ${event.toolName}`;
        else if (event.type === 'error') activity = event.error;
        if (activity.trim()) this.emitActivity(taskId, presetName, activity.trim().slice(0, 700), event.type === 'error' ? 'failed' : 'running');
      },
    });
  }

  private async runAgentTask(
    taskId: string,
    presetName: string,
    task: string,
    definition: SubagentDefinition,
    context: ToolExecutionContext
  ): Promise<void> {
    const resultPath = path.isAbsolute(this.resultsDir)
      ? this.resultsDir
      : path.join(context.workingDirectory, this.resultsDir);
    await fs.mkdir(resultPath, { recursive: true });

    try {
      const result = await this.executeSubagent(taskId, presetName, task, definition, context);
      this.emitActivity(taskId, presetName, result, 'completed');
      await this.writeResult(resultPath, {
        taskId,
        presetName,
        status: 'completed',
        result,
        error: null,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.emitActivity(taskId, presetName, getErrorMessage(error), 'failed');
      await this.writeResult(resultPath, {
        taskId,
        presetName,
        status: 'failed',
        result: null,
        error: getErrorMessage(error),
        completedAt: new Date().toISOString(),
      });
    }
  }

  private emitActivity(taskId: string, agentName: string, activity: string, status: 'running' | 'completed' | 'failed'): void {
    this.onEvent?.({ type: 'subagent_activity', taskId, agentName, activity, status });
  }

  private async writeResult(resultsDir: string, data: AgentResultData): Promise<void> {
    await fs.writeFile(
      path.join(resultsDir, `${data.taskId}.json`),
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }
}

export function registerSpawnAgentTools(
  toolRegistry: ToolRegistry,
  options: {
    apiKeys?: Record<string, string>;
    apiKey?: string;
    model: string;
    subagentRegistry: SubagentRegistry;
    onEvent?: (event: AgentEvent) => void;
    currentDepth?: number;
    maxDepth?: number;
    resultsDir?: string;
  }
): void {
  toolRegistry.register(new ReadAgentResultTool(options.resultsDir));
  toolRegistry.register(new ListAgentResultsTool(options.resultsDir));
  toolRegistry.register(
    new SpawnAgentTool({
      ...options,
      toolRegistry,
    })
  );
}
