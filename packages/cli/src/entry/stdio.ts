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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { createMarketDataProvider } from '@dyna/plugin-dynamind-api';
import {
  AgentCore,
  AgentRegistry,
  AgentTaskService,
  AnthropicProvider,
  AuditTrail,
  createExchangeAdapter,
  createTradingTools,
  createDynaSdkInvoker,
  DeepSeekProvider,
  ExecutionRouterImpl,
  GoogleProvider,
  HaltState,
  HooksManager,
  JsonRpcServer,
  loadConfig,
  loadWorkspaceAgentPrompt,
  LMStudioProvider,
  MarketDataTool,
  MemoryStoreImpl,
  ModelRouterImpl,
  NodeReplService,
  NodeReplTool,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  PaperEngine,
  PythonReplService,
  PythonReplTool,
  registerAgentTools,
  requireVisibleResponse,
  RunCardManager,
  SessionReplRuntime,
  SkillLoader,
  SkillManager,
  SqliteMemoryStore,
  StateDb,
  SubprocessReplKernelFactory,
  ToolRegistryImpl,
  getStatePath,
  getWorkspacePath,
} from '@dyna/core/cli';
import type { DelegationRequest } from '@dyna/core/cli';
import { StdioDelegatedTaskState } from './delegated-task-state.js';

const showThinking = process.env['DYNA_SHOW_THINKING']?.toLowerCase() !== 'false';
const traceStartup = process.env['DYNATRADER_STARTUP_TRACE'] === '1';
function startupStage(stage: string): void {
  if (traceStartup) process.stderr.write(`[startup] ${Date.now()} ${stage}\n`);
}
startupStage('stdio module loaded');

async function loadToolHooks(hooksManager: HooksManager, projectPath: string, workspacePath: string, statePath: string): Promise<void> {
  const configPaths = [
    join(projectPath, 'hooks.config.json'),
    join(projectPath, '.dynamind', 'hooks.config.json'),
    join(workspacePath, 'hooks.config.json'),
    join(workspacePath, '.dynamind', 'hooks.config.json'),
    join(statePath, 'hooks.config.json'),
    join(homedir(), '.dynamind', 'hooks.config.json'),
  ];
  let config: Record<string, any> | undefined;
  for (const configPath of [...new Set(configPaths)]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { config = parsed as Record<string, any>; break; }
    } catch { /* Try the next supported config location. */ }
  }
  const hooks = config?.eventHooks ?? config?.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  const run = (command: string, payload: Record<string, unknown>): Promise<{ code: number | null; stdout: string }> => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(0, 64 * 1024); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout }); });
    child.stdin.end(JSON.stringify(payload));
  });
  const eventToolHook = (eventName: 'PreToolUse' | 'PostToolUse', event: 'pre-tool-call' | 'post-tool-call') => {
    const matchers = hooks[eventName];
    if (!Array.isArray(matchers)) return;
    for (const [matcherIndex, matcherConfig] of matchers.entries()) {
      if (!matcherConfig || typeof matcherConfig !== 'object' || !Array.isArray(matcherConfig.hooks)) continue;
      const matcher = typeof matcherConfig.matcher === 'string' ? matcherConfig.matcher : '*';
      const escapedMatcher = matcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      let matcherRegex: RegExp;
      try { matcherRegex = new RegExp(`^${escapedMatcher}$`, 'i'); } catch { continue; }
      for (const [hookIndex, hook] of matcherConfig.hooks.entries()) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command.trim()) continue;
        hooksManager.register({
          id: `configured-${eventName}-${matcherIndex}-${hookIndex}`,
          event,
          handler: async ({ data }) => {
            const eventData = data && typeof data === 'object' ? data as Record<string, any> : {};
            const call = event === 'pre-tool-call'
              ? eventData
              : (eventData['toolCall'] && typeof eventData['toolCall'] === 'object' ? eventData['toolCall'] as Record<string, unknown> : {});
            const toolName = String(call['tool'] ?? '');
            if (!matcherRegex.test(toolName)) return { continue: true };
            const toolInput = call['args'] && typeof call['args'] === 'object' ? call['args'] as Record<string, unknown> : {};
            const payload = {
              hook_event_name: eventName,
              session_id: 'default',
              transcript_path: '',
              cwd: projectPath,
              tool_name: toolName,
              tool_input: toolInput,
              ...(event === 'post-tool-call' ? { tool_result: eventData['result'] } : {}),
            };
            try {
              const result = await run(hook.command, payload);
              if (event !== 'pre-tool-call') return { continue: true };
              if (result.code !== 0) return { continue: false, modify: { reason: `PreToolUse hook exited with code ${result.code}` } };
              const output = JSON.parse(result.stdout || '{}') as { decision?: string; reason?: string; continue?: boolean; stopReason?: string };
              if (output.decision === 'block' || output.continue === false) {
                return { continue: false, modify: { reason: output.reason ?? output.stopReason ?? 'Blocked by configured PreToolUse hook' } };
              }
              return { continue: true };
            } catch (error) {
              return event === 'pre-tool-call'
                ? { continue: false, modify: { reason: `PreToolUse hook failed: ${error instanceof Error ? error.message : String(error)}` } }
                : { continue: true };
            }
          },
        });
      }
    }
  };
  eventToolHook('PreToolUse', 'pre-tool-call');
  eventToolHook('PostToolUse', 'post-tool-call');
  const pre = hooks.preTool;
  if (pre?.enabled && typeof pre.command === 'string' && pre.command.trim()) {
    hooksManager.register({ id: 'configured-pre-tool', event: 'pre-tool-call', handler: async ({ data }) => {
      try {
        const toolCall = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const result = await run(pre.command, {
          toolName: toolCall['tool'],
          toolInput: toolCall['args'],
          timestamp: new Date().toISOString(),
        });
        if (result.code !== 0) return { continue: false, modify: { reason: `Pre-tool hook exited with code ${result.code}` } };
        const output = JSON.parse(result.stdout || '{}') as { shouldBlock?: boolean; message?: string; decision?: string; reason?: string };
        const shouldBlock = output.shouldBlock || output.decision === 'block';
        return shouldBlock ? { continue: false, modify: { reason: output.message ?? output.reason ?? 'Blocked by configured pre-tool hook' } } : { continue: true };
      } catch (error) { return { continue: false, modify: { reason: `Pre-tool hook failed: ${error instanceof Error ? error.message : String(error)}` } }; }
    } });
  }
  const post = hooks.postTool;
  if (post?.enabled && typeof post.command === 'string' && post.command.trim()) {
    hooksManager.register({ id: 'configured-post-tool', event: 'post-tool-call', handler: async ({ data }) => {
      const event = data && typeof data === 'object' ? data as Record<string, any> : {};
      const toolCall = event['toolCall'] && typeof event['toolCall'] === 'object' ? event['toolCall'] as Record<string, unknown> : {};
      await run(post.command, {
        toolName: toolCall['tool'],
        toolInput: toolCall['args'],
        toolResult: event['result'],
        timestamp: new Date().toISOString(),
      }).catch(() => undefined);
      return { continue: true };
    } });
  }
}

function registerResearchTools(
  toolRegistry: ToolRegistryImpl,
  statePath: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
): string[] {
  const exchange = createExchangeAdapter({
    mode: config.runtime.mode,
    exchangeId: config.exchange.id,
    exchangeIds: config.exchange.ids,
  });
  if (!exchange) return [];

  const useExchangeData = process.env['DYNA_MARKET_DATA_PROVIDER'] === 'exchange';
  const requestedTimeout = Number(process.env['DYNAMIND_API_TIMEOUT_MS'] ?? 20_000);
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(25_000, Math.max(1_000, requestedTimeout)) : 20_000;
  const marketDataProvider = useExchangeData ? undefined : createMarketDataProvider({
    baseUrl: process.env['DYNAMIND_API_URL'] ?? 'https://api.dynamind.network',
    apiKey: process.env['DYNAMIND_API_KEY'],
    timeoutMs,
  });
  const marketDataSource = useExchangeData ? exchange.id : 'dynamind-api';
  toolRegistry.register(new MarketDataTool({ exchange, marketDataProvider, marketDataSource }));
  const paperEngine = new PaperEngine({
    initialBalance: 10_000,
    commissionRate: 0.001,
    slippageRate: 0.001,
    feeCurrency: 'USD',
  }, exchange);
  const executionRouter = new ExecutionRouterImpl({
    liveTradingEnabled: false,
    microLiveEnabled: false,
    requireApprovalForLive: true,
    maxMicroLiveOrderValue: 0,
    audit: new AuditTrail(statePath),
    paperEngine,
    exchangeAdapters: new Map(),
    haltState: new HaltState(join(statePath, 'state')),
    validateOrder: () => 'Order execution is not exposed by the standalone research runtime.',
  });
  const risk = config.tradingRisk;
  const riskLimits = risk
    && typeof risk.maxPositionPct === 'number'
    && typeof risk.maxDailyLossPct === 'number'
    && typeof risk.maxConcurrentPositions === 'number'
    ? {
        maxPositionPct: risk.maxPositionPct,
        maxDailyLossPct: risk.maxDailyLossPct,
        maxConcurrentPositions: risk.maxConcurrentPositions,
      }
    : undefined;
  const readOnlyTools = new Set(['indicators', 'scan_market', 'size_position', 'backtest']);
  const registered: string[] = ['market_data'];
  for (const tool of createTradingTools({
    exchange,
    marketDataProvider,
    marketDataSource,
    paperEngine,
    executionRouter,
    defaultMode: 'research',
    getRiskLimits: () => riskLimits,
    getEquity: async () => paperEngine.getPortfolio().equity,
  })) {
    if (!readOnlyTools.has(tool.definition.name)) continue;
    toolRegistry.register(tool);
    registered.push(tool.definition.name);
  }
  return registered;
}

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
  startupStage('initialization started');
  // 1. Create persistent SQLite memory store (state.db)
  const memoryDir = getStatePath();
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
  const taskStateDb = new StateDb(existsSync(statePath) && statSync(statePath).isDirectory() ? statePath : memoryDir);
  const agentTaskService = new AgentTaskService(taskStateDb);
  const delegatedTaskState = new StdioDelegatedTaskState(agentTaskService);
  let taskStateDbClosed = false;
  const closeTaskStateDb = (): void => {
    if (taskStateDbClosed) return;
    taskStateDbClosed = true;
    taskStateDb.close();
  };
  process.once('exit', closeTaskStateDb);
  const sqliteBackend = new SqliteMemoryStore(dbPath);
  const memory = new MemoryStoreImpl(sqliteBackend);
  startupStage('memory store ready');

  // 2. Create model router with auto-detected providers
  const modelRouter = new ModelRouterImpl({
    workspacePath: process.cwd(),
  });
  registerModelProviders(modelRouter);
  startupStage('model providers registered');

  // 4. Create tool registry (minimal set for stdio mode)
  const projectPath = process.cwd();
  const workspacePath = getWorkspacePath();
  const toolRegistry = new ToolRegistryImpl({
    defaultMaxOutputLength: 64 * 1024,
    outputArtifactDirectory: join(memoryDir, 'tool-results'),
  });
  const runtimeConfig = await loadConfig(memoryDir);
  startupStage('configuration loaded');
  try {
    const researchTools = registerResearchTools(toolRegistry, memoryDir, runtimeConfig);
    if (researchTools.length > 0) {
      process.stderr.write(`Standalone research tools ready: ${researchTools.join(', ')}\n`);
    } else {
      process.stderr.write('No exchange is configured; standalone quant tools are unavailable.\n');
    }
  } catch (error) {
    process.stderr.write(`Standalone quant tools unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const runCardManager = new RunCardManager(memoryDir);
  const workspacePrompt = await loadWorkspaceAgentPrompt(workspacePath);
  startupStage('workspace prompt loaded');
  const agentRegistry = new AgentRegistry(workspacePath, [join(projectPath, '.dynamind', 'agents')]);
  await agentRegistry.load();
  startupStage('agent registry loaded');
  const allowedDirectories = [...new Set([projectPath, workspacePath])];
  // Stdio intentionally has a project + agent-workspace root boundary; the
  // interactive UI host owns its own host interaction and browser setup.
  registerAgentTools(toolRegistry, {
    host: 'stdio',
    projectRoot: projectPath,
    workspaceRoot: workspacePath,
    allowedDirectories,
    filesystem: true,
    // Standalone stdio is a read-only quant host: no workspace mutation or
    // arbitrary process execution is registered or advertised to the model.
    mutations: false,
    execution: false,
    web: true,
    memoryStore: memory,
    memoryBackend: sqliteBackend,
    sessionSearch: true,
  });
  toolRegistry.register({
    definition: { name: 'agent_task_list', description: 'List delegated agent tasks and their status.', category: 'session', inputSchema: {}, outputSchema: { tasks: 'array' }, permissionsRequired: ['session.read'], sideEffects: [], riskLevel: 'low', timeoutMs: 5000, readOnly: true },
    execute: async (_call, context) => ({ success: true, data: delegatedTaskState.list(context?.sessionId ?? agent.getActiveSession()?.id ?? 'default'), durationMs: 0, truncated: false }),
  });
  toolRegistry.register({
    definition: { name: 'agent_task_status', description: 'Get the status and result of a delegated agent task.', category: 'session', inputSchema: { task_id: 'string' }, outputSchema: { task: 'object' }, permissionsRequired: ['session.read'], sideEffects: [], riskLevel: 'low', timeoutMs: 5000, readOnly: true },
    execute: async (call, context) => {
      const task = delegatedTaskState.get(String(call.args.task_id ?? ''), context?.sessionId ?? agent.getActiveSession()?.id ?? 'default');
      if (!task) return { success: false, error: 'Delegated task not found. Use agent_task_list to list tasks.', durationMs: 0, truncated: false };
      return { success: true, data: task, durationMs: 0, truncated: false };
    },
  });
  toolRegistry.register({
    definition: { name: 'agent_task_cancel', description: 'Cancel a running delegated agent task.', category: 'session', inputSchema: { task_id: 'string' }, outputSchema: { cancelled: 'boolean' }, permissionsRequired: ['session.spawn'], sideEffects: ['cancels_agent'], riskLevel: 'medium', timeoutMs: 5000 },
    execute: async (call, context) => {
      const taskId = String(call.args.task_id ?? '');
      const cancelled = delegatedTaskState.cancel(taskId, context?.sessionId ?? agent.getActiveSession()?.id ?? 'default');
      return { success: true, data: { cancelled, ...(cancelled ? { task_id: taskId } : {}) }, durationMs: 0, truncated: false };
    },
  });
  let agent: AgentCore;
  toolRegistry.register({
    definition: {
      name: 'sessions_list',
      description: 'List available conversation sessions and their message counts.',
      category: 'session',
      inputSchema: {},
      outputSchema: { sessions: 'array', count: 'number' },
      permissionsRequired: [],
      sideEffects: [],
      riskLevel: 'low',
      timeoutMs: 5_000,
      readOnly: true,
    },
    execute: async () => {
      const sessions = agent.listSessions().map((session) => ({
        ...session,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      }));
      return { success: true, data: { sessions, count: sessions.length }, durationMs: 0, truncated: false };
    },
  });
  toolRegistry.register({
    definition: {
      name: 'sessions_history',
      description: 'Read recent messages from a conversation session. Use this for exact transcript context; memory_search is for durable saved records.',
      category: 'session',
      inputSchema: { sessionId: { type: 'string', optional: true }, limit: 'number?' },
      outputSchema: { sessionId: 'string', messages: 'array', count: 'number' },
      permissionsRequired: [],
      sideEffects: [],
      riskLevel: 'low',
      timeoutMs: 5_000,
      readOnly: true,
    },
    execute: async (call) => {
      const activeId = agent.getActiveSession()?.id;
      const requested = typeof call.args.sessionId === 'string' ? call.args.sessionId.trim() : '';
      const sessionId = requested || activeId || 'default';
      if (sessionId !== 'default' && !agent.listSessions().some((session) => session.id === sessionId)) {
        return { success: false, error: `Session not found: ${sessionId}`, durationMs: 0, truncated: false };
      }
      const limitValue = call.args.limit;
      const limit = typeof limitValue === 'number' && Number.isFinite(limitValue)
        ? Math.max(1, Math.min(200, Math.floor(limitValue)))
        : 50;
      const messages = agent.getConversationHistory(sessionId).slice(-limit).map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp,
      }));
      return { success: true, data: { sessionId, messages, count: messages.length }, durationMs: 0, truncated: false };
    },
  });

  const skillLoader = new SkillLoader();
  skillLoader.registerPath('workspace', workspacePath);
  // Skill catalogs come from the agent workspace and user-level installations.
  // Never scan the checked-out project to discover skills; the model uses the
  // registered skills_list/skill_view tools for inventory and loading.
  const userHome = homedir();
  for (const root of [
    join(userHome, '.agents'),
    process.env['CODEX_HOME']?.trim() || join(userHome, '.codex'),
    join(userHome, '.claude'),
    join(userHome, '.config', 'opencode'),
    join(userHome, '.hermes'),
  ]) {
    skillLoader.registerPath('personal', root);
  }
  skillLoader.registerPath('personal', join(userHome, '.config', 'opencode'), 'skill');
  await skillLoader.loadAll();
  startupStage(`skill catalog loaded (${skillLoader.getAllSkills().length})`);
  const skillManager = new SkillManager(join(workspacePath, 'skills'));
  const hooksManager = new HooksManager();
  await loadToolHooks(hooksManager, projectPath, workspacePath, memoryDir);

  // 5. Create AgentCore
  agent = new AgentCore({
    memory,
    modelRouter,
    toolRegistry,
    defaultMode: 'paper',
    runCardManager,
    workspacePath: projectPath,
    workspacePrompt,
    skillLoader,
    skillManager,
hooksManager,
  });
  startupStage('agent core ready');

  // 6. Register the code-execution surface.
  //
  // The standalone research runtime deliberately exposes no financial tools one
  // at a time. Instead the model writes code in node_repl / python_repl and
  // chains SDK calls through the injected `sdk` stub, so a multi-step analysis
  // is a single turn rather than N tool round-trips. Both kernels are separate
  // child processes launched with a minimal environment -- they hold none of
  // this process's credentials -- and they are NOT a sandbox.
  const sdkInvoker = createDynaSdkInvoker((call, context) =>
    agent.executeSdkTool(call, context)
  );
  const replRuntime = new SessionReplRuntime(
    new SubprocessReplKernelFactory({ cwd: workspacePath }),
    sdkInvoker,
    { timeoutMs: 30_000, maxOutputChars: 32_000 }
  );
  toolRegistry.register(new NodeReplTool(new NodeReplService(replRuntime)));
  toolRegistry.register(new PythonReplTool(new PythonReplService(replRuntime)));
  startupStage('repl runtime ready');
  const runDelegatedTask = async (request: DelegationRequest): Promise<{ agent: string; content: string }> => {
    const requestedAgent = request.agent?.trim();
    const manifest = requestedAgent
      ? await agentRegistry.find(requestedAgent)
      : await agentRegistry.getDefault().catch(() => undefined);
    if (requestedAgent && !manifest) throw new Error(`Agent not found: ${requestedAgent}. Available: ${(await agentRegistry.getAll()).map((item) => item.name).join(', ') || 'none'}`);
    const agentName = manifest?.name ?? 'coding-worker';
    const workerInstructions = manifest?.instructions?.trim() || workspacePrompt ||
      'You are a careful coding worker. Inspect the workspace, make the requested change with the available tools, and report what changed and how it was verified.';
    const allowedTools = manifest?.tools?.allow?.filter(Boolean);
    const childToolRegistry = toolRegistry.restrict({
      ...(allowedTools?.length ? { allow: allowedTools } : {}),
      deny: ['delegate_task', 'agent_task_list', 'agent_task_status', 'agent_task_cancel', 'skill_manage', ...(manifest?.tools?.deny ?? [])],
    });
    const child = new AgentCore({
      memory,
      modelRouter,
      toolRegistry: childToolRegistry,
      workspacePath: projectPath,
      workspacePrompt: workerInstructions,
      skillLoader,
      skillManager,
      budgetConfig: {
        maxIterations: 50,
        maxTimeMs: 5 * 60_000,
        maxMemoryUsage: 512 * 1024 * 1024,
        maxApiCalls: 200,
      },
      maxToolTurns: manifest?.maxTurns ?? 50,
    });
    const task = request.context
      ? `${request.task}\n\nContext:\n${JSON.stringify(request.context)}`
      : request.task;
    const stream = await child.chatStream(task, { allowTools: true, signal: request.signal });
    let childText = '';
    let childFailed = '';
    for await (const chunk of stream) {
      request.onEvent?.(agentName, chunk);
      if (chunk.type === 'content') childText += chunk.content ?? '';
      if (chunk.type === 'error') childFailed = chunk.error ?? 'Child agent failed.';
    }
    if (childFailed) throw new Error(childFailed);
    if (!requireVisibleResponse(childText, undefined, `Delegation to ${agentName}`, showThinking)) {
      throw new Error(`Child agent ${agentName} returned no visible result.`);
    }
    return {
      agent: agentName,
      content: childText,
    };
  };

  agent.setDelegateTask(async (request) => {
    if (request.executionMode !== 'async') return runDelegatedTask(request);
    const taskId = `agent_${randomUUID()}`;
    const manifest = request.agent ? await agentRegistry.find(request.agent) : await agentRegistry.getDefault().catch(() => undefined);
    const controller = new AbortController();
    const task = delegatedTaskState.start({
      taskId,
      sessionId: request.sessionId ?? agent.getActiveSession()?.id ?? 'default',
      agent: manifest?.name ?? request.agent ?? 'coding-worker',
      task: request.task,
      controller,
    });
    void runDelegatedTask({ ...request, signal: controller.signal }).then(
      (result) => {
        delegatedTaskState.complete(taskId, request.sessionId ?? agent.getActiveSession()?.id ?? 'default', result);
      },
      (error) => {
        delegatedTaskState.fail(taskId, request.sessionId ?? agent.getActiveSession()?.id ?? 'default', error instanceof Error ? error.message : String(error));
      },
    );
    return { task_id: taskId, agent: task.agent, status: task.status };
  });

  // 6. Create and start JSON-RPC server (stdin/stdout transport)
  const server = new JsonRpcServer({ agent, modelRouter, agentTaskService });
  server.start();
  startupStage('json-rpc server started');

  // Signal readiness on stderr (not stdout, which is reserved for JSON-RPC)
  process.stderr.write('DynaTrader stdio agent ready\n');

  // Handle graceful shutdown
  const shutdown = (): void => {
    server.stop();
    closeTaskStateDb();
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
