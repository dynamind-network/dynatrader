#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { PROVIDERS, findProviderForModel, initProvidersFromYAML } from './core/providers/index.js';
import { getApiKeys, loadSettings } from './config/settings.js';
import { initProviders } from './config/providers.js';
import { initMarketConfig } from './config/market.js';
import { loadConfig } from './config/config.js';
import { resolveSubagentMaxTurns } from './config/agent-defaults.js';
import { JsonRpcClient } from './rpc/client.js';
import { resolveDynatraderLaunchSpec } from './core/dynatrader-launcher.js';

// Load model providers from YAML before any PROVIDERS access
await initProvidersFromYAML();

let sessionInfoToDisplay: { id: string; title: string } | null = null;

export function setSessionInfoForExit(info: { id: string; title: string } | null): void {
  sessionInfoToDisplay = info;
}

const args = process.argv.slice(2);

// Handle --help / -h
if (args.includes('--help') || args.includes('-h')) {
  const availableModels = Object.values(PROVIDERS)
    .flatMap((p) => p.models)
    .map((m) => m.id)
    .join(', ');

  console.log(`DynaTrader Terminal

Usage: dynatrader [options]

Options:
  -h, --help          Show this help message
  -m, --model         Model to use (e.g., deepseek-chat, gpt-4o)
  -p, --prompt        Prompt to send to the AI
  -s, --session       Session ID to resume
  --connect           Connect to a provider (e.g., deepseek, openai)
  --no-tui            Run in non-interactive CLI mode (outputs response to stdout)

Available models:
  ${availableModels}

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

let initialPrompt: string | undefined;
let modelOverride: string | null = null;
let connectProvider: string | undefined;
let noTui = false;
let sessionId: string | undefined;

// Parse options
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // --no-tui
  if (arg === '--no-tui') {
    noTui = true;
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

  // -s, --session (session ID to resume)
  if (arg === '-s' || arg === '--session') {
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      sessionId = nextArg;
      i++;
    } else if (arg.includes('=')) {
      sessionId = arg.split('=')[1];
    }
    continue;
  }
}

// If --connect specified, use first available model from that provider
if (connectProvider) {
  const providerLower = connectProvider.toLowerCase();
  const providerConfig = Object.values(PROVIDERS).find(
    (p) => p.name.toLowerCase() === providerLower
  );
  if (providerConfig && providerConfig.models.length > 0) {
    modelOverride = providerConfig.models[0].id;
  }
}

// Non-interactive CLI mode
if (noTui) {
  if (!initialPrompt) {
    console.error('Error: --prompt is required in --no-tui mode');
    process.exit(1);
  }

  const runCli = async () => {
    // Spawn the DynaTrader runtime SDK as a child process and communicate via JSON-RPC
    const launchSpec = resolveDynatraderLaunchSpec();
    const client = new JsonRpcClient(launchSpec.command, launchSpec.args);

    try {
      const result = await client.call<{
        content: string;
        state: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        durationMs: number;
        compacted: boolean;
      }>('prompt.submit', {
        message: initialPrompt!,
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
  const resolvedModel = modelOverride || null;

  const runInteractive = async (): Promise<void> => {
    // Initialize API providers from config.json
    // and derive the TUI turn cap from workspace config instead of hardcoding it.
    // This is intentionally loaded before rendering so the UI always has a sane default.
    const appConfig = await loadConfig();
    initProviders(appConfig.providers);
    initMarketConfig(appConfig.market);

    const terminalMaxTurns =
      typeof appConfig.terminal?.maxTurns === 'number' &&
      Number.isFinite(appConfig.terminal.maxTurns) &&
      appConfig.terminal.maxTurns > 0
        ? Math.floor(appConfig.terminal.maxTurns)
        : resolveSubagentMaxTurns();

    const defaultConfig = {
      model: resolvedModel,
      maxTurns: terminalMaxTurns,
      cwd: process.cwd(),
      verbose: false,
    };

    const { waitUntilExit } = render(
      React.createElement(App, {
        apiKeys: {},
        config: defaultConfig,
        initialPrompt,
        sessionId,
      }),
      {
        exitOnCtrlC: false,
      }
    );

    // Setup signal handlers for graceful exit
    const cleanup = async (): Promise<void> => {
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
  };

  runInteractive().catch((error: Error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
