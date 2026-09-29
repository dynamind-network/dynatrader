/**
 * CLI Command: setup, logs, config, version, compact, agents
 */

import type { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import { bold, cyan, green, red, yellow, dim, formatDuration, printSeparator, printHeader } from '../utils';
import { getWorkspacePath, ensureWorkspace } from '../../workspace-init';
import { loadConfig, saveConfig } from '../../config';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import { ContextCompactionEngine } from '../../context/context-compaction-engine';
import packageJson from '../../../package.json';


export async function cmdSetup(): Promise<void> {
  printHeader('DynaTrader Workspace Setup');
  console.log();

  const workspacePath = getWorkspacePath();
  console.log(bold('Workspace:'));
  console.log(`  Path: ${resolve(workspacePath)}`);
  console.log();

  console.log(dim('Creating workspace if needed...'));
  await ensureWorkspace();
  console.log(green('  Workspace ready.'));
  console.log();

  let config = await loadConfig(workspacePath);

  console.log(bold('Exchange Configuration:'));
  console.log('  Available: configured in workspace config or environment');
  console.log(`  Current:   ${config.exchange.id}`);
  console.log(`  Sandbox:   ${config.exchange.sandbox}`);
  console.log();
  console.log(dim('  API keys are configured via environment variables:'));
  console.log(dim('    EXCHANGE_API_KEY, EXCHANGE_SECRET, EXCHANGE_PASSPHRASE (or venue-specific variables)'));
  console.log();

  console.log(bold('Model Provider:'));
  const providers = ['openai', 'anthropic', 'openrouter', 'deepseek', 'google', 'ollama', 'lmstudio'];
  console.log(`  Available: ${providers.join(', ')}`);
  console.log(`  Current:   ${config.models.provider}`);
  console.log();
  console.log(dim('  API keys are configured via environment variables:'));
  console.log(dim('    OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY, OLLAMA_BASE_URL, LM_STUDIO_BASE_URL'));
  console.log();

  console.log(bold('Runtime Mode:'));
  const modes = ['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'];
  console.log(`  Available: ${modes.join(', ')}`);
  console.log(`  Current:   ${config.runtime.mode}`);
  console.log();

  console.log(bold('Launch Scope:'));
  console.log('  Product:   focused financial market agent runtime');
  console.log('  Channels:  Telegram, Discord, Slack, Signal');
  console.log('  Safety:    explicit symbol/timeframe for new entries, close-only unwind for exits');
  console.log();

  await saveConfig(workspacePath, config);
  console.log(green(`Configuration saved to ${join(workspacePath, 'config.yaml')}`));
  console.log();

  console.log(bold('Setup Summary:'));
  console.log(`  Workspace:  ${resolve(workspacePath)}`);
  console.log(`  Exchange:   ${config.exchange.id} (sandbox: ${config.exchange.sandbox})`);
  console.log(`  Provider:   ${config.models.provider}`);
  console.log(`  Mode:       ${config.runtime.mode}`);
  console.log();
  console.log(dim('To customize, edit config.yaml or use environment variables.'));
  console.log(dim('See .env.example for all available environment variables.'));
  console.log();
}

// cmdDoctor has been moved to ./doctor.ts

export async function cmdLogs(
  workspacePath: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const logDir = join(workspacePath, 'logs');
  const logFile = join(logDir, 'daemon.log');

  await mkdir(logDir, { recursive: true });

  const lines = typeof flags.lines === 'string' ? parseInt(flags.lines, 10) || 50 : 50;
  const follow = flags['follow'] === true || flags['f'] === true;
  const filter = typeof flags.filter === 'string' ? flags.filter : '';

  if (!existsSync(logFile)) {
    await writeFile(logFile, '', 'utf-8');
    console.log(yellow('Daemon log file is empty.'));
    console.log(dim(`  ${logFile}`));
    console.log();
    if (!follow) return;
  }

  const readTail = (): void => {
    try {
      const content = readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);

      let displayLines = allLines;
      if (filter) {
        displayLines = displayLines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
      }
      if (displayLines.length > lines) {
        displayLines = displayLines.slice(displayLines.length - lines);
      }

      console.clear();
      console.log(bold(cyan('Daemon Log')));
      printSeparator();
      console.log(dim(`  File: ${logFile}`));
      if (filter) console.log(dim(`  Filter: "${filter}"`));
      console.log(dim(`  Lines: ${displayLines.length} (showing last ${Math.min(displayLines.length, lines)})`));
      console.log();

      for (const line of displayLines) {
        const colored = line
          .replace(/\b(ERROR|FATAL)\b/g, red('$&'))
          .replace(/\b(WARN|WARNING)\b/g, yellow('$&'))
          .replace(/\b(INFO)\b/g, green('$&'))
          .replace(/\b(DEBUG|TRACE)\b/g, dim('$&'));
        console.log(`  ${colored}`);
      }
    } catch {
      // Ignore read errors during polling
    }
  };

  readTail();

  if (follow) {
    console.log();
    console.log(dim('  Watching for new log entries... (Ctrl+C to stop)'));
    const interval = setInterval(readTail, 500);
    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });
    await new Promise<void>(() => {});
  } else {
    console.log();
  }
}

export async function cmdConfig(
  workspacePath: string,
  sub: string,
  args: string[],
): Promise<void> {
  const configFilePath = join(workspacePath, 'config.yaml');

  const readConfig = async (): Promise<Record<string, unknown>> => {
    try {
      const content = await readFile(configFilePath, 'utf-8');
      const { default: yaml } = await import('js-yaml');
      return yaml.load(content) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  switch (sub) {
    case 'list': {
      console.log();
      console.log(bold(cyan('Configuration')));
      printSeparator();

      console.log(bold('  Environment:'));
      const envKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LM_STUDIO_BASE_URL', 'DYNA_WORKSPACE', 'DYNA_MODE', 'EXCHANGE_ID', 'EXCHANGE_API_KEY', 'EXCHANGE_SECRET', 'EXCHANGE_PASSPHRASE'];
      for (const key of envKeys) {
        const val = process.env[key];
        if (val) {
          const display = key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('PASSPHRASE') ? '[set]' : val;
          console.log(`    ${key}=${dim(display)}`);
        }
      }
      console.log();

      console.log(bold('  Workspace Config:'));
      const config = await readConfig();
      const configKeys = Object.keys(config);
      if (configKeys.length === 0) {
        console.log(yellow('    No workspace config values set.'));
      } else {
        for (const key of configKeys) {
          const val = config[key];
          const display = typeof val === 'string' && (key.includes('key') || key.includes('secret') || key.includes('password'))
            ? '***'
            : JSON.stringify(val);
          console.log(`    ${key}=${dim(display)}`);
        }
      }
      console.log();
      break;
    }

    case 'get': {
      const key = args[0];
      if (!key) {
        console.log(red('Error: key is required.'));
        console.log(dim('Usage: dynatrader config get <key>'));
        return;
      }

      const envVal = process.env[key];
      if (envVal !== undefined) {
        const sensitive = key.includes('KEY') || key.includes('SECRET') || key.includes('PASSWORD');
        const display = sensitive || key.includes('TOKEN') || key.includes('PASSPHRASE') ? '[set]' : envVal;
        console.log(`${key}=${display} ${dim('(from environment)')}`);
        return;
      }

      const config = await readConfig();
      if (key in config) {
        const val = config[key];
        const display = typeof val === 'string' && (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret'))
          ? '***'
          : JSON.stringify(val);
        console.log(`${key}=${display} ${dim('(from workspace config)')}`);
      } else {
        console.log(yellow(`Config key not found: ${key}`));
      }
      break;
    }

    case 'set': {
      const key = args[0];
      const value = args.slice(1).join(' ');
      if (!key || !value) {
        console.log(red('Error: key and value are required.'));
        console.log(dim('Usage: dynatrader config set <key> <value>'));
        return;
      }

      const config = await readConfig();
      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Keep as string
      }

      config[key] = parsedValue;
      const { default: yaml } = await import('js-yaml');
      await writeFile(configFilePath, yaml.dump(config, {
        indent: 2,
        lineWidth: 100,
        noRefs: true,
        sortKeys: false,
      }), 'utf-8');
      console.log(green(`Config set: ${key}=${JSON.stringify(parsedValue)}`));
      console.log(dim(`  File: ${configFilePath}`));
      break;
    }

    case 'validate': {
      console.log();
      console.log(bold(cyan('Configuration Validation')));
      printSeparator();

      let allOk = true;

      const required = ['OPENAI_API_KEY'];
      for (const key of required) {
        if (process.env[key]) {
          console.log(`  ${green('[OK]')} ${key} is set`);
        } else {
          console.log(`  ${yellow('[WARN]')} ${key} is not set (recommended)`);
        }
      }

      const config = await readConfig();
      const configKeys = Object.keys(config);
      if (configKeys.length > 0) {
        console.log(`  ${green('[OK]')} Workspace config has ${configKeys.length} keys`);
      } else {
        console.log(`  ${yellow('[WARN]')} Workspace config is empty`);
      }

      if (existsSync(workspacePath)) {
        console.log(`  ${green('[OK]')} Workspace path exists: ${resolve(workspacePath)}`);
      } else {
        console.log(`  ${red('[FAIL]')} Workspace path does not exist: ${resolve(workspacePath)}`);
        allOk = false;
      }

      if (allOk) {
        console.log();
        console.log(green('Configuration is valid.'));
      } else {
        console.log();
        console.log(yellow('Configuration has issues. Review warnings above.'));
      }
      console.log();
      break;
    }

    default: {
      console.log(red(`Unknown config subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader config <list|get|set|validate> [key] [value]'));
    }
  }
}

export function cmdVersion(workspacePath: string): void {
  const version = packageJson.version;

  console.log();
  console.log(bold(cyan(`DynaTrader v${version}`)));
  printSeparator();
  console.log(`  Version:     ${bold(version)}`);
  console.log(`  Product:     DynaTrader financial market runtime`);
  console.log(`  Runtime:     ${typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`}`);
  console.log(`  Platform:    ${platform()} ${process.arch}`);
  console.log(`  Workspace:   ${resolve(workspacePath)}`);
  console.log(`  Mode:        ${process.env.DYNA_MODE || 'research'}`);
  console.log(`  PID:         ${process.pid}`);
  console.log(`  Node:        ${process.version}`);
  console.log(`  CWD:         ${process.cwd()}`);
  console.log();
}

export function cmdCompact(
  runtime: DynaTraderRuntime,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const memory = runtime.getMemory();

  if (flags.status) {
    console.log();
    console.log(bold(cyan('Context Compaction Status')));
    printSeparator();

    const config = {
      maxContextTokens: 80000,
      autoCompactThreshold: 0.75,
      reserveTokens: 4000,
      keepRecentMessages: 10,
      recentTailTokens: 20000,
      preCompactionFlush: true,
      protectToolPairs: true,
    };

    console.log(`  Max Context Tokens: ${bold(String(config.maxContextTokens))}`);
    console.log(`  Auto-Compact Threshold: ${bold(`${(config.autoCompactThreshold * 100).toFixed(0)}%`)}`);
    console.log(`  Reserve Tokens: ${bold(String(config.reserveTokens))}`);
    console.log(`  Keep Recent Messages: ${bold(String(config.keepRecentMessages))}`);
    console.log(`  Recent Tail Tokens: ${bold(String(config.recentTailTokens))}`);
    console.log(`  Pre-Compaction Flush: ${config.preCompactionFlush ? green('enabled') : yellow('disabled')}`);
    console.log(`  Tool Pair Protection: ${config.protectToolPairs ? green('enabled') : yellow('disabled')}`);
    console.log();
    return Promise.resolve();
  }

  console.log();
  console.log(bold(cyan('Running Context Compaction')));
  printSeparator();

  const compactionSink = {
    write: (entry: { scope: string; kind: string; payload: unknown; timestamp: Date }) =>
      memory.put({ scope: entry.scope, kind: entry.kind, payload: entry.payload, ts: entry.timestamp }),
  };

  const engine = new ContextCompactionEngine(compactionSink, {
    maxContextTokens: 80000,
    autoCompactThreshold: 0.75,
    reserveTokens: 4000,
    keepRecentMessages: 10,
    recentTailTokens: 20000,
    preCompactionFlush: true,
    protectToolPairs: true,
  });

  const messages = [
    { role: 'system' as const, content: 'DynaTrader trading agent context' },
    { role: 'user' as const, content: 'Analyze market conditions for the configured market pair' },
    { role: 'assistant' as const, content: 'I will analyze the current market conditions...' },
  ];

  const usage = engine.getTokenUsage(messages);
  console.log(`  Current Token Usage: ${bold(String(usage.totalTokens))} / ${String(usage.maxTokens)} (${(usage.usagePercent * 100).toFixed(1)}%)`);

  if (flags.dynamic) {
    console.log(dim('  Running dynamic compaction with importance scoring...'));
    return engine.manualCompact(messages).then((result) => {
      console.log(green(`  Compaction complete!`));
      console.log(`  Tokens saved: ${bold(String(result.tokensSaved))}`);
      console.log(`  Compression ratio: ${bold(`${(result.compressionRatio * 100).toFixed(1)}%`)}`);
      console.log(`  Messages compressed: ${bold(String(result.messagesRemoved))}`);
      console.log(`  Tool pairs protected: ${bold(String(result.toolPairsProtected))}`);
      console.log(`  Recent messages kept: ${bold(String(result.recentMessagesKept))}`);

      const stats = engine.getStats();
      console.log();
      console.log(bold('  Session Stats:'));
      console.log(`    Total Compactions: ${String(stats.totalCompactions)}`);
      console.log(`    Total Tokens Saved: ${String(stats.totalTokensSaved)}`);
      console.log(`    Auto Compactions: ${String(stats.autoCompactions)}`);
      console.log(`    Manual Compactions: ${String(stats.manualCompactions)}`);
      console.log();
    });
  } else {
    console.log(dim('  Running auto-compaction...'));
    return engine.autoCompact(messages).then((result) => {
      console.log(green(`  Compaction complete!`));
      console.log(`  Tokens saved: ${bold(String(result.tokensSaved))}`);
      console.log(`  Compression ratio: ${bold(`${(result.compressionRatio * 100).toFixed(1)}%`)}`);
      console.log(`  Messages compressed: ${bold(String(result.messagesRemoved))}`);

      const stats = engine.getStats();
      console.log();
      console.log(bold('  Session Stats:'));
      console.log(`    Total Compactions: ${String(stats.totalCompactions)}`);
      console.log(`    Total Tokens Saved: ${String(stats.totalTokensSaved)}`);
      console.log(`    Auto Compactions: ${String(stats.autoCompactions)}`);
      console.log(`    Manual Compactions: ${String(stats.manualCompactions)}`);
      console.log();
    });
  }
}

export function cmdAgents(workspace: { agents: Array<{ name?: string; version?: string; description?: string; riskLevel?: string; allowedModes?: string[]; skills?: { allow?: string[] }; tools?: { allow?: string[] } }> }): void {
  console.log();
  console.log(bold(cyan('Loaded Agent Profiles')));
  printSeparator();

  if (workspace.agents.length === 0) {
    console.log(yellow('  No agents loaded.'));
    console.log(dim('  Add .agent.md files to workspace/agents/'));
    console.log();
    return;
  }

  for (const agent of workspace.agents) {
    const name = agent.name || 'unnamed';
    const version = agent.version || '0.0.0';
    const description = agent.description || 'No description';
    const riskLevel = agent.riskLevel || 'low';
    const allowedModes = agent.allowedModes || [];
    const skills = agent.skills?.allow || [];
    const tools = agent.tools?.allow || [];

    console.log();
    console.log(bold(`  ${green(name)}`) + dim(` v${version}`));
    console.log(`    ${description}`);
    console.log(`    Risk Level: ${riskLevel === 'low' ? green(riskLevel) : riskLevel === 'high' ? red(riskLevel) : yellow(riskLevel)}`);
    if (allowedModes.length > 0) {
      console.log(`    Modes: ${allowedModes.join(', ')}`);
    }
    if (tools.length > 0) {
      console.log(`    Tools: ${tools.join(', ')}`);
    }
    if (skills.length > 0) {
      console.log(`    Skills: ${skills.join(', ')}`);
    }
  }

  console.log();
}
