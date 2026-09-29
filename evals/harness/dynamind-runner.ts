/**
 * DynaMind Eval Suite — Full Agent Runtime Runner
 *
 * Bootstraps the real AgentCore with all harness components:
 * - Memory (MemoryStoreImpl + MemorySearchTool + MemoryWriteTool)
 * - Tools (ReadTool, GlobTool, GrepTool, WebFetchTool, MemorySearchTool)
 * - Hooks (HooksManager with trajectory capture)
 * - Context assembly (PromptAssembly via AgentCore)
 * - Session search (CrossSessionRecall)
 * - Skills (SkillFactory + SkillLoader)
 * - Loop detection (GraduatedLoopDetector)
 * - Compaction (ContextCompactionEngine)
 *
 * This runner measures the FULL agent, not just the model.
 */

import type { EvalScenario, EvalTrace, TrajectoryStep } from './types';
import type { AgentRunner } from './runner';
import { classifyToolProfiles, type ToolProfile } from './tool-profiles';
import {
  resolveProfiles,
  getToolsForProfiles,
  CORE_PROFILES,
  PLUGIN_PROFILES,
} from '../../src/runtime/tools/tool-profiles';
import { MemoryStoreImpl } from '../../src/memory/core/memory-store';
import { ModelRouterImpl } from '../../src/orchestration/models/model-router';
import { LMStudioProvider } from '../../src/orchestration/models/providers/lmstudio';
import { ToolRegistryImpl } from '../../src/runtime/tools/tool-registry';
import { ReadTool } from '../../src/runtime/tools/tools/read-tool';
import { GlobTool } from '../../src/runtime/tools/tools/glob-tool';
import { GrepTool } from '../../src/runtime/tools/tools/grep-tool';
import { WebFetchTool } from '../../src/runtime/tools/tools/web-fetch-tool';
import { MemorySearchTool } from '../../src/runtime/tools/tools/memory-search-tool';
import { MemoryWriteTool } from '../../src/runtime/tools/tools/memory-write-tool';
import { WriteTool } from '../../src/runtime/tools/tools/write-tool';
import { EditTool } from '../../src/runtime/tools/tools/edit-tool';
import { ExecTool } from '../../src/runtime/tools/tools/exec-tool';
import { SessionSearchTool } from '../../src/runtime/tools/tools/session-search-tool';
import { AgentCore } from '../../src/agent/core/agent-core';
import { HooksManager } from '../../src/agent/core/hooks';
import { CrossSessionRecall } from '../../src/agent/core/cross-session-recall';
import type { HookContext, HookResult } from '../../src/agent/core/hooks';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DynaMindRunnerConfig {
  model?: string;
  baseUrl?: string;
  workspacePath?: string;
  maxIterations?: number;
  maxTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Trajectory Capture
// ---------------------------------------------------------------------------

interface CapturedStep {
  event: string;
  data: unknown;
  timestamp: Date;
}

/**
 * Creates a HooksManager that captures trajectory steps for eval.
 */
function createTrajectoryHooks(): {
  hooks: HooksManager;
  steps: CapturedStep[];
} {
  const hooks = new HooksManager();
  const steps: CapturedStep[] = [];

  // Capture pre-LLM calls
  hooks.register({
    id: 'eval-pre-llm',
    event: 'pre-llm-call',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'pre-llm-call', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  // Capture post-LLM calls
  hooks.register({
    id: 'eval-post-llm',
    event: 'post-llm-call',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'post-llm-call', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  // Capture pre-tool calls
  hooks.register({
    id: 'eval-pre-tool',
    event: 'pre-tool-call',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'pre-tool-call', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  // Capture post-tool calls
  hooks.register({
    id: 'eval-post-tool',
    event: 'post-tool-call',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'post-tool-call', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  // Capture errors
  hooks.register({
    id: 'eval-on-error',
    event: 'on-error',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'on-error', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  // Capture compaction events
  hooks.register({
    id: 'eval-on-compaction',
    event: 'on-compaction',
    priority: -1000,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      steps.push({ event: 'on-compaction', data: ctx.data, timestamp: ctx.timestamp });
      return { continue: true };
    },
  });

  return { hooks, steps };
}

// ---------------------------------------------------------------------------
// Build Trajectory from ChatResponse
// ---------------------------------------------------------------------------

function buildTrajectory(
  response: {
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{
      tool: string;
      args: Record<string, unknown>;
      result: { success: boolean; data?: unknown; error?: string; durationMs: number };
      durationMs: number;
    }>;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    durationMs: number;
  },
  hookSteps: CapturedStep[],
): TrajectoryStep[] {
  const trajectory: TrajectoryStep[] = [];
  let stepNum = 0;

  // Add hook-captured steps as reasoning/tool_call actions
  for (const step of hookSteps) {
    if (step.event === 'pre-llm-call' || step.event === 'post-llm-call') {
      const data = step.data as { messages?: unknown[]; model?: string };
      trajectory.push({
        step: stepNum++,
        action: 'reasoning',
        output: `[LLM call via harness] model=${data?.model ?? 'unknown'} messages=${data?.messages?.length ?? 0}`,
        latency_ms: 0,
        timestamp: step.timestamp.toISOString(),
      });
    } else if (step.event === 'pre-tool-call' || step.event === 'post-tool-call') {
      const data = step.data as { tool?: string; args?: Record<string, unknown>; result?: unknown };
      if (step.event === 'post-tool-call' && data?.result) {
        // Record tool result
        const result = data.result as { success: boolean; data?: unknown; error?: string };
        trajectory.push({
          step: stepNum++,
          action: 'tool_result',
          tool: data.tool,
          output: result.success
            ? JSON.stringify(result.data).slice(0, 500)
            : `ERROR: ${result.error}`,
          latency_ms: 0,
          timestamp: step.timestamp.toISOString(),
        });
      } else {
        // Record tool call
        trajectory.push({
          step: stepNum++,
          action: 'tool_call',
          tool: data?.tool,
          output: JSON.stringify(data?.args ?? {}).slice(0, 200),
          latency_ms: 0,
          timestamp: step.timestamp.toISOString(),
        });
      }
    } else if (step.event === 'on-error') {
      trajectory.push({
        step: stepNum++,
        action: 'error',
        output: JSON.stringify(step.data).slice(0, 200),
        latency_ms: 0,
        timestamp: step.timestamp.toISOString(),
      });
    }
  }

  // Add tool calls from ChatResponse (the actual executed tools)
  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      trajectory.push({
        step: stepNum++,
        action: 'tool_call',
        tool: tc.tool,
        output: JSON.stringify(tc.args).slice(0, 200),
        latency_ms: tc.durationMs,
        timestamp: new Date().toISOString(),
      });
      trajectory.push({
        step: stepNum++,
        action: 'tool_result',
        tool: tc.tool,
        output: tc.result.success
          ? JSON.stringify(tc.result.data).slice(0, 500)
          : `ERROR: ${tc.result.error}`,
        latency_ms: tc.result.durationMs,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Add reasoning content if present
  if (response.reasoningContent) {
    trajectory.push({
      step: stepNum++,
      action: 'reasoning',
      output: response.reasoningContent.slice(0, 1000),
      latency_ms: 0,
      timestamp: new Date().toISOString(),
    });
  }

  // Add final decision
  trajectory.push({
    step: stepNum++,
    action: 'decision',
    output: response.content,
    latency_ms: response.durationMs,
    timestamp: new Date().toISOString(),
  });

  return trajectory;
}

// ---------------------------------------------------------------------------
// Create DynaMind Agent Runner
// ---------------------------------------------------------------------------

/**
 * Creates an AgentRunner that uses the full DynaMind agent runtime.
 *
 * This bootstraps:
 * - AgentCore with all harness components
 * - MemoryStoreImpl (in-memory for eval isolation)
 * - ModelRouterImpl + LMStudioProvider (local model)
 * - ToolRegistryImpl with generic tools
 * - HooksManager with trajectory capture
 * - CrossSessionRecall for session search
 *
 * The key difference from the baseline runner:
 * - Model gets full context assembly (three-tier prompt building)
 * - Model can use tools (read, search, memory, web)
 * - Hooks fire around LLM and tool calls
 * - Memory retrieval happens automatically
 * - Context compaction happens when needed
 * - Loop detection prevents infinite loops
 */
export function createDynaMindRunner(config?: DynaMindRunnerConfig): AgentRunner {
  const baseUrl = config?.baseUrl ?? process.env['LM_STUDIO_BASE_URL'] ?? 'http://localhost:1234';
  const workspacePath = config?.workspacePath ?? process.cwd();

  return {
    async run(scenario: EvalScenario) {
      // Determine tool profiles from scenario or family
      const toolProfiles = scenario.tool_profiles ?? classifyToolProfiles(scenario.family).profiles;

      // Create a fresh agent per scenario with profile-based tools
      const agent = await bootstrapAgent(baseUrl, workspacePath, config?.model, toolProfiles);
      const { hooks, steps } = createTrajectoryHooks();

      // Inject trajectory-capture hooks into the agent
      // Note: AgentCore doesn't expose hooksManager directly, so we
      // capture via the ChatResponse.toolCalls and add hook data separately.
      // For now, we rely on ChatResponse which already has toolCalls.

      const startMs = Date.now();

      // Build the user message from the scenario
      // Include system context as part of the message since AgentCore
      // handles system prompt assembly internally
      const userMessage = buildUserMessage(scenario);

      try {
        const response = await agent.chat(userMessage, {
          allowTools: true,
          maxTokens: 4096,
        });

        const elapsedMs = Date.now() - startMs;

        // Build trajectory from response
        const trajectory = buildTrajectory(response, steps);

        // Extract decision from the final content
        const decision = response.content;

        return {
          trajectory,
          decision,
          cost_usd: 0, // local model = free
          tokens_in: response.usage.promptTokens,
          tokens_out: response.usage.completionTokens,
          model: config?.model ?? 'local-model',
        };
      } catch (err) {
        const elapsedMs = Date.now() - startMs;
        return {
          trajectory: [{
            step: 0,
            action: 'error',
            output: `AGENT_ERROR: ${(err as Error).message}`,
            latency_ms: elapsedMs,
            timestamp: new Date().toISOString(),
          }],
          decision: `ERROR: ${(err as Error).message}`,
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          model: config?.model ?? 'local-model',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap AgentCore
// ---------------------------------------------------------------------------

/**
 * Creates a ToolRegistry with tools scoped to the given profiles.
 * Uses canonical resolveProfiles() — core profiles always included,
 * plugin profiles only if available.
 */
function createScopedRegistry(
  profiles: ToolProfile[],
  workspacePath: string,
  memory: MemoryStoreImpl,
): ToolRegistryImpl {
  const resolved = resolveProfiles(profiles);
  const allowedToolNames = getToolsForProfiles(resolved);
  const allowedSet = new Set(allowedToolNames);

  const registry = new ToolRegistryImpl();

  // Register all tools — restrict() below filters the view
  // Base profile tools
  registry.register(new ReadTool({
    allowedDirectories: [workspacePath],
    workspaceRoot: workspacePath,
  }));
  registry.register(new GlobTool([workspacePath], workspacePath));
  registry.register(new GrepTool([workspacePath], workspacePath));
  registry.register(new WebFetchTool());
  registry.register(new WriteTool({
    allowedDirectories: [workspacePath],
    workspaceRoot: workspacePath,
  }));
  registry.register(new EditTool({
    allowedDirectories: [workspacePath],
    workspaceRoot: workspacePath,
  }));

  // Memory profile tools
  registry.register(new MemorySearchTool(memory));
  registry.register(new MemoryWriteTool(memory));

  // Multi-agent profile tools
  registry.register(new SessionSearchTool(memory));

  // Trading profile tools
  registry.register(new ExecTool({
    workspaceRoot: workspacePath,
    defaultCwd: workspacePath,
  }));

  // Create restricted view — only tools matching the resolved profiles
  return registry.restrict({
    allow: allowedToolNames,
  }) as ToolRegistryImpl;
}

async function bootstrapAgent(
  baseUrl: string,
  workspacePath: string,
  model?: string,
  profiles: ToolProfile[] = ['base'],
): Promise<AgentCore> {
  // 1. Memory (in-memory for eval isolation)
  const memory = new MemoryStoreImpl();

  // 2. Model Router + LM Studio provider
  const modelRouter = new ModelRouterImpl({ workspacePath });
  const lmstudioProvider = new LMStudioProvider({
    baseUrl,
    model,
    maxTokens: 4096,
    temperature: 0.2,
  });
  modelRouter.registerProvider(lmstudioProvider);

  // 3. Tool Registry — profile-scoped via canonical resolution + restrict()
  const toolRegistry = createScopedRegistry(profiles, workspacePath, memory);

  // 4. Hooks (for trajectory capture)
  const hooksManager = new HooksManager();

  // 5. CrossSessionRecall (session search)
  const crossSessionRecall = new CrossSessionRecall(memory);
  await crossSessionRecall.loadFromMemory();

  // 6. Determine maxToolTurns based on profiles
  const resolved = resolveProfiles(profiles);
  const hasMultiAgent = resolved.includes('multi_agent');
  const hasTrading = resolved.includes('trading');
  const maxToolTurns = hasMultiAgent || hasTrading ? 10 : 3;

  // 7. AgentCore with full harness
  const agent = new AgentCore({
    memory,
    modelRouter,
    toolRegistry,
    hooksManager,
    crossSessionRecall,
    defaultMode: 'paper',
    workspacePath,
    budgetConfig: {
      maxIterations: 20,
      maxTimeMs: 120_000,
      maxMemoryUsage: 50 * 1024 * 1024,
      maxApiCalls: 50,
    },
    maxToolTurns,
    compressToolResults: false,
  });

  return agent;
}

// ---------------------------------------------------------------------------
// Build User Message
// ---------------------------------------------------------------------------

/**
 * Constructs the user message for the agent.
 *
 * The scenario has:
 * - system_prompt: what the agent should do
 * - task: the actual data/question
 * - fixtures: optional pre-loaded data
 *
 * We combine system_prompt + task + fixtures into a single user message
 * because AgentCore handles system prompt assembly internally via SOUL.md
 * and workspace configuration.
 *
 * For eval, we embed the scenario instructions in the user message.
 */
function buildUserMessage(scenario: EvalScenario): string {
  const parts: string[] = [];

  // The scenario.task already contains the full task with embedded data.
  // We just need to pass it through. AgentCore handles system prompt
  // assembly internally via SOUL.md and workspace configuration.
  parts.push(scenario.task);

  return parts.join('\n');
}
