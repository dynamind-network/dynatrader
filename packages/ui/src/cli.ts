#!/usr/bin/env node
import { parseCliSessionOptions } from './cli-session-options.js';

const args = process.argv.slice(2);

let sessionInfoToDisplay: { id: string; title: string } | null = null;
const startupTrace = process.env['DYNATRADER_STARTUP_TRACE'] === '1';
const startupStartedAt = performance.now();

function reportStartupStage(stage: string): void {
  if (startupTrace) {
    process.stderr.write(`[startup +${Math.round(performance.now() - startupStartedAt)}ms] ${stage}\n`);
  }
}

async function traceStartupImport<T>(name: string, load: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await load();
  reportStartupStage(`${name} imported in ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

export function setSessionInfoForExit(info: { id: string; title: string } | null): void {
  sessionInfoToDisplay = info;
}

// Handle --help / -h
if (args.includes('--help') || args.includes('-h')) {
  console.log(`DynaTrader Terminal

Usage: dynatrader [options]

Options:
  -h, --help          Show this help message
  -m, --model         Model to use (e.g., deepseek-chat, gpt-4o)
  -p, --prompt        Prompt to send to the AI
  -s, --session       Session ID to resume
  --resume <id>       Resume a specific session
  -c, --continue      Resume the most recently updated session
  --connect           Connect to a provider (e.g., deepseek, openai)
  --no-daemon         Use the local standalone coding agent runtime
  --no-tui            Run in non-interactive CLI mode (outputs response to stdout)

Available providers:
  deepseek, openai, anthropic, google, lmstudio

Examples:
  dynatrader                    Start interactive terminal
  dynatrader -p "Hello"         Start with initial prompt
  dynatrader -m deepseek-chat -p "Hello"
  dynatrader --no-tui -p "Say hello"
  dynatrader -s session-abc123  Resume a previous session`);
  process.exit(0);
}

// Defer the runtime and provider graph until after --help. The TUI imports
// the full agent, exchange, and terminal stacks; loading those for a help page
// can take minutes on a clean consumer install.
async function loadRuntimeModules() {
  // Loading independent-looking module trees concurrently causes severe disk
  // and module-loader contention on Windows, where each tree has many files.
  // Keep this small bootstrap sequential so the terminal becomes interactive
  // much sooner on a cold start.
  const providerRegistry = await traceStartupImport('provider registry', () => import('./core/providers/registry.js'));
  const providerCatalog = await traceStartupImport('provider catalog', () => import('./core/providers/catalog.js'));
  const settings = await traceStartupImport('settings', () => import('./config/settings.js'));
  const providers = await traceStartupImport('provider config', () => import('./config/providers.js'));
  const market = await traceStartupImport('market config', () => import('./config/market.js'));
  const config = await traceStartupImport('workspace config', () => import('./config/config.js'));
  const agentDefaults = await traceStartupImport('agent defaults', () => import('./config/agent-defaults.js'));
  const rpc = await traceStartupImport('RPC client', () => import('./rpc/client.js'));
  const launcher = await traceStartupImport('runtime launcher', () => import('./core/dynatrader-launcher.js'));
  await providerRegistry.initProvidersFromYAML();
  return { providerRegistry, providerCatalog, settings, providers, market, config, agentDefaults, rpc, launcher };
}

function applyConnectProvider(
  connectProvider: string | undefined,
  providers: Awaited<ReturnType<typeof loadRuntimeModules>>['providerRegistry']['PROVIDERS'],
  modelOverride: string | null,
): string | null {
  if (!connectProvider) return modelOverride;
  const providerConfig = Object.values(providers).find(
    (provider) => provider.name.toLowerCase() === connectProvider.toLowerCase(),
  );
  return providerConfig?.models[0]?.id ?? modelOverride;
}

let initialPrompt: string | undefined;
let modelOverride: string | null = null;
let connectProvider: string | undefined;
let noTui = false;
const sessionOptions = parseCliSessionOptions(args);
let sessionId = sessionOptions.sessionId;

// Parse options
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // --no-tui
  if (arg === '--no-tui') {
    noTui = true;
    continue;
  }

  if (arg === '--no-daemon') {
    process.env.DYNATRADER_NO_DAEMON = 'true';
    continue;
  }

  // -p, --prompt
  if (arg === '-p' || arg === '--prompt') {
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      initialPrompt = nextArg;
      i++;
    } else if (arg.includes('=')) {
      initialPrompt = arg.split('=')[1];
    }
    continue;
  }

  // -m, --model
  if (arg === '-m' || arg === '--model') {
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      modelOverride = nextArg;
      i++;
    } else if (arg.includes('=')) {
      modelOverride = arg.split('=')[1];
    }
    continue;
  }

  // --connect (connect to a provider)
  if (arg === '--connect') {
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      connectProvider = nextArg;
      i++;
    } else if (arg.includes('=')) {
      connectProvider = arg.split('=')[1];
    }
    continue;
  }

}

if ((sessionOptions.resumeRequested || sessionOptions.sessionRequested) && !sessionId) {
  console.error('Error: --resume and --session require a session ID. Use --continue to resume the latest session.');
  process.exit(2);
}

if (noTui && sessionOptions.continueSession && !sessionId) {
  console.error('Error: --continue requires interactive TUI mode. Use --resume <id> to select a session in non-interactive mode.');
  process.exit(2);
}

// Non-interactive CLI mode
if (noTui) {
  if (!initialPrompt) {
    console.error('Error: --prompt is required in --no-tui mode');
    process.exit(1);
  }

  const runCli = async () => {
    const runtime = await loadRuntimeModules();
    modelOverride = applyConnectProvider(connectProvider, runtime.providerRegistry.PROVIDERS, modelOverride);
    // Spawn the DynaTrader runtime SDK as a child process and communicate via JSON-RPC
    const appConfig = await runtime.config.loadConfig();
    runtime.providers.initProviders(appConfig.providers);
    runtime.market.initMarketConfig(appConfig.market);
    const settings = await runtime.settings.loadSettings();
    const apiKeys = await runtime.settings.getApiKeys(settings);
    const providerEnv: NodeJS.ProcessEnv = {};
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (!key?.trim()) continue;
      const envName = provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : provider === 'lmstudio'
          ? 'LM_STUDIO_API_KEY'
          : `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
      providerEnv[envName] = key;
      if (provider === 'google') providerEnv.GEMINI_API_KEY ??= key;
    }
    const launchSpec = runtime.launcher.resolveDynatraderLaunchSpec();
    const client = new runtime.rpc.JsonRpcClient(launchSpec.command, launchSpec.args, providerEnv);

    try {
      if (modelOverride) {
        const provider = runtime.providerCatalog.findProviderForModel(modelOverride);
        if (provider) {
          const modelId = modelOverride.includes('/') ? modelOverride : `${provider}/${modelOverride}`;
          await client.call('model.switch', { modelId });
        }
      }
      const result = await client.call<{
        content: string;
        state: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        durationMs: number;
        compacted: boolean;
      }>('prompt.submit', {
        message: initialPrompt!,
        ...(sessionId ? { sessionId } : {}),
      });

      console.log(result.content);
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      client.close();
    }
  };

  runCli();
} else {
  // Interactive TUI mode
  const React = await traceStartupImport('React', () => import('react').then((module) => module.default));
  const ink = await traceStartupImport('Ink terminal', () => import('@dynatrader/ink/terminal'));
  const { MouseInputBus } = await traceStartupImport('mouse input bus', () => import('./ui/input/mouse-input.js'));
  const { createMouseInputBridge } = await traceStartupImport('mouse input bridge', () => import('./ui/input/mouse-input-bridge.js'));
  const { MouseInputProvider } = await traceStartupImport('mouse input provider', () => import('./ui/input/MouseInputProvider.js'));
  const runtime = await traceStartupImport('runtime module graph', () => loadRuntimeModules());
  const { App } = await traceStartupImport('TUI application', () => import('./ui/App.js'));
  const { render } = ink;
  reportStartupStage('runtime and application modules loaded');
  modelOverride = applyConnectProvider(connectProvider, runtime.providerRegistry.PROVIDERS, modelOverride);
  const resolvedModel = modelOverride || null;

  const runInteractive = async (): Promise<void> => {
    // Initialize API providers from config.json
    // and derive the TUI turn cap from workspace config instead of hardcoding it.
    // This is intentionally loaded before rendering so the UI always has a sane default.
    const appConfig = await runtime.config.loadConfig();
    reportStartupStage('workspace configuration loaded');
    runtime.providers.initProviders(appConfig.providers);
    runtime.market.initMarketConfig(appConfig.market);

    const terminalMaxTurns =
      typeof appConfig.terminal?.maxTurns === 'number' &&
      Number.isFinite(appConfig.terminal.maxTurns) &&
      appConfig.terminal.maxTurns > 0
        ? Math.floor(appConfig.terminal.maxTurns)
        : runtime.agentDefaults.resolveSubagentMaxTurns();

    const defaultConfig = {
      model: resolvedModel,
      maxTurns: terminalMaxTurns,
      cwd: process.cwd(),
      verbose: false,
    };

    const mouseBus = new MouseInputBus();
    const mouseInput = createMouseInputBridge(process.stdin, mouseBus);
    const { waitUntilExit } = render(
      React.createElement(
        MouseInputProvider,
        { bus: mouseBus },
        React.createElement(App, {
          apiKeys: {},
          config: defaultConfig,
          initialPrompt: initialPrompt ?? '',
          sessionId,
          continueSession: sessionOptions.continueSession,
        })
      ),
      {
        exitOnCtrlC: false,
        stdin: mouseInput.stdin as unknown as NodeJS.ReadStream,
      }
    );
    reportStartupStage('interactive application rendered');

    // Setup signal handlers for graceful exit
    const cleanup = async (): Promise<void> => {
      process.stdout.write('\u001b[?1002l\u001b[?1006l\u001b[?1004l');
      mouseInput.dispose();
      // Display session info if available (set by App before exit)
      if (sessionInfoToDisplay) {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  Session saved');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Session: ${sessionInfoToDisplay.id} - "${sessionInfoToDisplay.title}"`);
        console.log(`  Continue: dynamind -s ${sessionInfoToDisplay.id}`);
        console.log('═══════════════════════════════════════════════════════════');
      }
      process.exit(0);
    };

    // Register signal handlers - these will be overridden by the App to add save functionality
    process.on('SIGINT', () => {
      cleanup();
    });

    process.on('SIGTERM', () => {
      cleanup();
    });

    // Handle unexpected termination - at least show session info
    process.on('SIGHUP', () => {
      cleanup();
    });

    await waitUntilExit();
    process.stdout.write('\u001b[?1002l\u001b[?1006l\u001b[?1004l');
    mouseInput.dispose();
  };

  runInteractive().catch((error: Error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

