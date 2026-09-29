/**
 * DynaTrader Standalone Agent (stdio mode)
 *
 * Reads JSON-RPC from stdin, writes to stdout.
 * This is the entry point for running DynaTrader as a standalone process
 * that other applications communicate with via
 * the JSON-RPC protocol over stdio.
 *
 * Creates a minimal but fully functional AgentCore with:
 * - Persistent SQLite memory store (~/.dynatrader/state.db)
 * - Default risk engine
 * - Default agent runtime
 * - Model router with auto-detected providers (env-based)
 * - Tool registry with basic built-in tools
 *
 * Usage:
 *   node dist/entry/stdio.js
 *   # or via the smart launcher:
 *   dynatrader --stdio
 */

import { MemoryStoreImpl } from '@dyna/memory-core';
import { SqliteMemoryStore } from '@dyna/memory-sqlite';
import { ModelRouterImpl, OpenAIProvider, AnthropicProvider, OllamaProvider, LMStudioProvider, OpenRouterProvider, DeepSeekProvider, GoogleProvider } from '@dyna/model-router';
import { ToolRegistryImpl, ReadTool, GlobTool, GrepTool, WriteTool, EditTool, ExecTool, WebFetchTool, WebSearchTool } from '@dyna/tools-runtime';
import { AgentCore } from '../agent/core/agent-core';
import { JsonRpcServer } from '../gateway/json-rpc/server';
import { loadWorkspaceAgentPrompt } from '../runtime/workspace-agent-prompt';
import { AgentRegistry } from '../runtime/subagents/agent-registry';
import { RunCardManager } from '../governance/run-cards';
import { format } from 'node:util';
import { requireVisibleResponse } from '../runtime/visible-response';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, statSync } from 'node:fs';

const showThinking = process.env['DYNA_SHOW_THINKING']?.toLowerCase() !== 'false';

// stdout is reserved exclusively for newline-delimited JSON-RPC frames. Some
// dependency loggers use console.* internally, so route those diagnostics to
// stderr before initializing the runtime.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`);
}

// ---------------------------------------------------------------------------
// Model provider auto-detection
// ---------------------------------------------------------------------------

function registerModelProviders(modelRouter: ModelRouterImpl): void {
  if (process.env['OPENAI_API_KEY']) {
    try {
      modelRouter.registerProvider(new OpenAIProvider());
    } catch {
      // Provider registration failed — non-fatal
    }
  }

  if (process.env['ANTHROPIC_API_KEY']) {
    try {
      modelRouter.registerProvider(new AnthropicProvider());
    } catch {
      // Provider registration failed — non-fatal
    }
  }

  for (const [key, create] of [
    ['OPENROUTER_API_KEY', () => new OpenRouterProvider()],
    ['DEEPSEEK_API_KEY', () => new DeepSeekProvider()],
    ['GOOGLE_API_KEY', () => new GoogleProvider()],
  ] as const) {
    if (process.env[key] || (key === 'GOOGLE_API_KEY' && process.env['GEMINI_API_KEY'])) {
      try { modelRouter.registerProvider(create()); } catch { /* non-fatal provider detection */ }
    }
  }

  // Always attempt Ollama and LM Studio (local providers, no API key needed)
  try {
    modelRouter.registerProvider(new OllamaProvider());
  } catch {
    // Ollama not available
  }

  try {
    modelRouter.registerProvider(new LMStudioProvider({
      baseUrl: process.env['LM_STUDIO_BASE_URL'],
      model: process.env['LM_STUDIO_MODEL'],
    }));
  } catch {
    // LM Studio not available
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Create persistent SQLite memory store (state.db)
  const memoryDir = join(homedir(), '.dynatrader');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  const statePath = join(memoryDir, 'state.db');
  // Older Windows installs kept SQLite's files inside a state.db directory.
  // Preserve and reopen that database instead of asking SQLite to open the
  // directory itself as a database file.
  const dbPath = existsSync(statePath) && statSync(statePath).isDirectory()
    ? join(statePath, 'state.db')
    : statePath;
  const sqliteBackend = new SqliteMemoryStore(dbPath);
  const memory = new MemoryStoreImpl(sqliteBackend);

  // 2. Create model router with auto-detected providers
  const modelRouter = new ModelRouterImpl({
    workspacePath: process.cwd(),
  });
  registerModelProviders(modelRouter);

  // 4. Create tool registry (minimal set for stdio mode)
  const toolRegistry = new ToolRegistryImpl();
  const workspacePath = process.cwd();
  const runCardManager = new RunCardManager(workspacePath);
  const workspacePrompt = await loadWorkspaceAgentPrompt(workspacePath);
  const agentRegistry = new AgentRegistry(workspacePath);
  await agentRegistry.load();
  toolRegistry.register(new ReadTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));
  toolRegistry.register(new GlobTool([workspacePath], workspacePath));
  toolRegistry.register(new GrepTool([workspacePath], workspacePath));
  toolRegistry.register(new WriteTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));
  toolRegistry.register(new EditTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));
  toolRegistry.register(new ExecTool({ defaultCwd: workspacePath }));
  toolRegistry.register(new WebFetchTool());
  toolRegistry.register(new WebSearchTool({ braveApiKey: process.env.BRAVE_API_KEY, tavilyApiKey: process.env.TAVILY_API_KEY, searxngBaseUrl: process.env.SEARXNG_BASE_URL }));

  // 5. Create AgentCore
  const agent = new AgentCore({
    memory,
    modelRouter,
    toolRegistry,
    defaultMode: 'paper',
    runCardManager,
    workspacePath,
    workspacePrompt,
  });
  agent.setDelegateTask(async (request) => {
    const requestedAgent = request.agent?.trim();
    const manifest = requestedAgent
      ? await agentRegistry.get(requestedAgent)
      : await agentRegistry.getDefault().catch(() => undefined);
    const agentName = manifest?.name ?? requestedAgent ?? 'coding-worker';
    const workerInstructions = manifest?.instructions?.trim() || workspacePrompt ||
      'You are a careful coding worker. Inspect the workspace, make the requested change with the available tools, and report what changed and how it was verified.';

    // Give each delegated worker a fresh conversation and the parent's tools,
    // while preventing recursive delegation from multiplying unboundedly.
    const childToolRegistry = toolRegistry.restrict({ deny: ['delegate_task', 'skill_manage'] });
    const child = new AgentCore({
      memory,
      modelRouter,
      toolRegistry: childToolRegistry,
      workspacePath,
      workspacePrompt: workerInstructions,
      maxToolTurns: 24,
      budgetConfig: {
        maxIterations: 24,
        maxTimeMs: 600_000,
        maxMemoryUsage: 128 * 1024 * 1024,
        maxApiCalls: 100,
      },
    });
    const task = request.context
      ? `${request.task}\n\nContext:\n${JSON.stringify(request.context)}`
      : request.task;
    const response = await child.chat(task, { allowTools: true, signal: request.signal });
    if (response.state !== 'idle' || !requireVisibleResponse(response.content, response.reasoningContent, `Delegation to ${agentName}`, showThinking)) {
      throw new Error(response.content || `Child agent ${agentName} returned no visible result.`);
    }
    return {
      agent: agentName,
      content: response.content,
      reasoningContent: response.reasoningContent,
      usage: response.usage,
      toolCalls: response.toolCalls?.map((call) => ({ tool: call.tool, success: call.result?.success })),
    };
  });

  // 6. Create and start JSON-RPC server (stdin/stdout transport)
  const server = new JsonRpcServer({ agent, modelRouter });
  server.start();

  // Signal readiness on stderr (not stdout, which is reserved for JSON-RPC)
  process.stderr.write('DynaTrader stdio agent ready\n');

  // Handle graceful shutdown
  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive — readline interface handles stdin
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
