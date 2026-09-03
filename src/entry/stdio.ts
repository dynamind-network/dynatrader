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
import { ToolRegistryImpl, ReadTool, GlobTool, GrepTool, WriteTool, EditTool, ExecTool, WebFetchTool } from '@dyna/tools-runtime';
import { AgentCore } from '../agent/core/agent-core';
import { JsonRpcServer } from '../gateway/json-rpc/server';
import { loadWorkspaceAgentPrompt } from '../runtime/workspace-agent-prompt';
import { AgentRegistry } from '../runtime/subagents/agent-registry';
import { RunCardManager } from '../governance/run-cards';
import { format } from 'node:util';
import { requireVisibleResponse } from '../runtime/visible-response';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

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
  const sqliteBackend = new SqliteMemoryStore(join(memoryDir, 'state.db'));
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
    const agentName = request.agent?.trim();
    if (!agentName) {
      throw new Error('Delegation requires an explicit agent name in stdio mode.');
    }

    const manifest = await agentRegistry.get(agentName);
    if (!manifest.instructions?.trim()) {
      throw new Error(`Agent ${agentName} has no workspace instructions configured.`);
    }

    const response = await modelRouter.call({
      messages: [
        {
          role: 'system',
          content: manifest.instructions.trim(),
        },
        {
          role: 'user',
          content: request.context
            ? `${request.task}\n\nContext:\n${JSON.stringify(request.context)}`
            : request.task,
        },
      ],
      maxTokens: 3000,
      temperature: 0.2,
      signal: request.signal,
    }, 'research');
    return {
      agent: agentName,
      content: requireVisibleResponse(response.content, response.reasoningContent, `Delegation to ${agentName}`, showThinking),
      reasoningContent: response.reasoningContent,
      usage: response.usage,
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
