#!/usr/bin/env node

/**
 * DynaTrader CLI
 *
 * Production-quality command-line interface for the DynaTrader trading agent
 * runtime. Uses only built-in process.argv parsing -- no external CLI frameworks.
 *
 * Commands:
 *   status             Show runtime status and component health
 *   trade              Run a single agent turn for the current market universe
 *   backtest <symbol>  Run backtest over historical data
 *   pipeline           Run multi-agent trading pipeline
 *   agents             List loaded agent profiles
 *   memory [query]     Show memory stats or search entries
 *   risk               Show current risk state
 *   cron               Manage scheduled cron jobs (list, add, update, remove, pause, resume, trigger, run, inspect)
 *   mcp                Manage workspace MCP servers (list, add, update, remove, enable, disable, inspect, server)
 *   kanban             Manage kanban task board (list, show, create, claim, transition, link)
 *   workspace          Manage trading workspaces (list, create, show, validate)
 *   gateway            Manage gateway connections (status, send)
 *   learning           Manage learning loop (skills, recall, review)
 *   --help             Show usage guide
 */

import { DynaTraderRuntime } from '@dyna/core/cli';
import type { TradeMode } from '@dyna/core/cli';

// Shared CLI utilities
import { parseArgs, getFlagString, getFlagNumber, bold, cyan, green, red, yellow, dim, printSeparator } from './cli/utils';
import { join } from 'path';
import { existsSync } from 'fs';
import { format } from 'node:util';
import { initRuntime } from './cli/runtime-init';
import { getWorkspacePath, getStatePath, StateDb } from '@dyna/core/cli';

// Extracted command modules
import { cmdStatus } from './cli/status';
import { cmdTrade } from './cli/trade';
import { cmdBacktest } from './cli/backtest';
import { cmdPipeline } from './cli/pipeline';
import { cmdMemory } from './cli/commands/memory';
import { cmdRisk } from './cli/commands/risk';
import { cmdCron } from './cli/commands/cron';
import { cmdMcp } from './cli/commands/mcp';
import { cmdKanban } from './cli/commands/kanban';
import { cmdWorkspace } from './cli/commands/workspace';
import { cmdGateway } from './cli/commands/gateway';
import { cmdLearning } from './cli/commands/learning';
import { cmdSetup, cmdLogs, cmdConfig, cmdVersion, cmdCompact, cmdAgents } from './cli/commands/misc';
import { cmdInit } from './cli/commands/init';
import { cmdDoctor } from './cli/commands/doctor';
import { cmdIssues, cmdTrack, cmdInbox } from './cli/commands/artifacts';
import { cmdPlugins } from './cli/commands/plugins';
import { cmdPortfolio } from './cli/commands/portfolio';
import { cmdSessions } from './cli/commands/sessions';
import { getCompletionScript, printCliHelp } from './cli/commands/help';

// =============================================================================
// Command: help
// =============================================================================

function cmdHelp(topic?: string): void {
  printCliHelp(topic);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  // JSON cron consumers parse stdout as a single machine-readable response.
  // Runtime boot emits human-oriented logger lines via console.log, so route
  // those diagnostics to stderr before runtime initialization begins.
  if (parsed.command === 'cron' && parsed.flags['json'] === true) {
    const stderrLog = (...args: unknown[]): void => { process.stderr.write(`${format(...args)}\n`); };
    console.log = stderrLog;
    console.info = stderrLog;
    console.debug = stderrLog;
  }

  // --stdio: delegate to the standalone stdio entry point
  // Used by Terminal (and other consumers) to spawn DynaTrader as a child process
  // communicating via JSON-RPC over stdin/stdout.
  if (parsed.flags['stdio'] === true) {
    // Dynamic import so the stdio entry is only loaded when needed
    await import('./entry/stdio.js');
    return;
  }

  // --help with no command
  if (!parsed.command) {
    cmdHelp();
    return;
  }

  const command = parsed.command;
  // Support both --workspace and --runtime flags for workspace path
  const wsFlag = getFlagString(parsed.flags, 'workspace', '');
  const rtFlag = getFlagString(parsed.flags, 'runtime', '');
  const globalWorkspace = wsFlag || rtFlag || getWorkspacePath();

  // Register graceful shutdown
  let runtime: DynaTraderRuntime | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (runtime) {
      console.log(dim('\nShutting down...'));
      try {
        await runtime.shutdown();
      } catch {
        // ignore shutdown errors
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown().catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown().catch(() => process.exit(1));
  });

  try {
    // -----------------------------------------------------------------------
    // Commands that DON'T need a running runtime
    // -----------------------------------------------------------------------
    if (command === 'help') {
      cmdHelp(parsed.positional[0]);
      return;
    }

    if (parsed.flags['help'] === true) {
      cmdHelp(command);
      return;
    }

    if (parsed.flags['json'] === true) {
      const jsonSupported = command === 'status' || command === 'doctor' || (command === 'gateway' && parsed.positional[0] === 'status') || command === 'cron';
      if (!jsonSupported) {
        console.error('--json is supported only by status, doctor, gateway status, and cron commands.');
        process.exitCode = 2;
        return;
      }
    }

    if (command === 'completion') {
      const shell = parsed.positional[0];
      if (!shell) {
        console.error('Usage: dynatrader completion <bash|zsh|powershell>');
        process.exitCode = 2;
      } else {
        try {
          process.stdout.write(getCompletionScript(shell));
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 2;
        }
      }
      return;
    }

    if (command === 'sessions') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.error('Usage: dynatrader sessions <list|show|export> [session-id] [--format markdown|json]');
        process.exitCode = 2;
        return;
      }
      const statePath = getStatePath();
      const databaseFile = join(statePath, 'state.db');
      if (!existsSync(databaseFile)) {
        console.log(sub === 'list' ? 'No saved conversations.' : `Conversation not found: ${parsed.positional[1] ?? ''}`);
        return;
      }
      const db = new StateDb(statePath);
      try {
        cmdSessions(db, sub, parsed.positional.slice(1), parsed.flags);
      } finally {
        db.close();
      }
      return;
    }

    if (command === 'init') {
      await cmdInit({ yes: parsed.flags['yes'] === true });
      return;
    }

    if (command === 'setup') {
      await cmdSetup();
      return;
    }

    if (command === 'doctor') {
      await cmdDoctor({
        fix: parsed.flags['fix'] === true,
        json: parsed.flags['json'] === true,
      });
      return;
    }

    if (command === 'logs') {
      await cmdLogs(getStatePath(), parsed.flags);
      return;
    }

    if (command === 'config') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.log(red('Error: config subcommand is required.'));
        console.log(dim('Usage: dynatrader config <list|get|set|validate> [key] [value]'));
        process.exit(1);
      }
      await cmdConfig(getStatePath(), sub, parsed.positional.slice(1));
      return;
    }

    if (command === 'version') {
      cmdVersion(globalWorkspace);
      return;
    }

    if (command === 'issues' || command === 'track' || command === 'inbox') {
      const sub = parsed.positional[0] ?? 'list';
      const args = parsed.positional.slice(1);
      if (command === 'issues') await cmdIssues(globalWorkspace, sub, args);
      else if (command === 'track') await cmdTrack(globalWorkspace, sub, args);
      else await cmdInbox(globalWorkspace, sub, args);
      return;
    }

    if (command === 'gateway') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.log(red('Error: gateway subcommand is required.'));
        console.log(dim('Usage: dynatrader gateway <run|start|stop|restart|status|logs|monit|install|uninstall|send> [args...]'));
        process.exit(1);
      }
      await cmdGateway(sub, parsed.positional.slice(1), getStatePath(), { json: parsed.flags.json === true });
      return;
    }

    if (command === 'mcp') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.log(red('Error: mcp subcommand is required.'));
        console.log(dim('Usage: dynatrader mcp <list|inspect|add|update|remove|enable|disable|server> [args...]'));
        process.exit(1);
      }
      await cmdMcp(getStatePath(), sub, parsed.positional.slice(1), parsed.flags);
      return;
    }

    // -----------------------------------------------------------------------
    // Commands that need runtime
    // -----------------------------------------------------------------------
    const globalMode = getFlagString(parsed.flags, 'mode', 'research') as
      | 'research'
      | 'paper'
      | 'backtest'
      | 'live';

    runtime = await initRuntime(globalWorkspace, globalMode);
    const workspace = await runtime.loadWorkspace();

    if (command === 'plugins') {
      const sub = parsed.positional[0] ?? 'list';
      await cmdPlugins(runtime, sub, parsed.positional.slice(1));
      return;
    }

    switch (command) {
      case 'status': {
        await cmdStatus(runtime, workspace, { json: parsed.flags.json === true });
        break;
      }

      case 'trade': {
        const tradeMode = getFlagString(parsed.flags, 'mode', 'paper') as TradeMode;
        await cmdTrade(runtime, tradeMode, { execute: parsed.flags.execute === true ? true : undefined });
        break;
      }

      case 'portfolio': {
        await cmdPortfolio(runtime);
        break;
      }

      case 'backtest': {
        const symbol = parsed.positional[0];
        if (!symbol) {
          console.log(red('Error: symbol is required.'));
          console.log(dim('Usage: dynatrader backtest <symbol> --timeframe <1m|5m|15m|1h|4h|1d> [--days 30]'));
          process.exit(1);
        }
        const timeframe = getFlagString(parsed.flags, 'timeframe', '');
        if (!timeframe) {
          console.log(red('Error: timeframe is required.'));
          console.log(dim('Usage: dynatrader backtest <symbol> --timeframe <1m|5m|15m|1h|4h|1d> [--days 30]'));
          process.exit(1);
        }
        const days = getFlagNumber(parsed.flags, 'days', 30);
        const start = getFlagString(parsed.flags, 'start', '');
        const end = getFlagString(parsed.flags, 'end', '');
        const venuesRaw = getFlagString(parsed.flags, 'venues', '');
        const venues = venuesRaw
          ? venuesRaw.split(',').map((value) => value.trim()).filter(Boolean)
          : undefined;
        await cmdBacktest(runtime, {
          symbol,
          timeframe,
          days,
          start: start || undefined,
          end: end || undefined,
          venues,
        });
        break;
      }

      case 'agents': {
        await cmdAgents(workspace);
        break;
      }

      case 'memory': {
        const query = parsed.positional[0];
        await cmdMemory(runtime, query);
        break;
      }

      case 'compact': {
        await cmdCompact(runtime, parsed.flags);
        break;
      }

      case 'risk': {
        await cmdRisk(runtime);
        break;
      }

      case 'halt': {
        const { HaltState } = await import('@dyna/core/cli');
        const reason = parsed.positional.length > 0 ? parsed.positional.join(' ') : 'Halted via CLI';
        const hs = new HaltState(join(getStatePath(), 'state'));
        const symbolFlag = getFlagString(parsed.flags, 'symbol', '');
        hs.halt(reason, 'cli', symbolFlag ? { symbol: symbolFlag } : 'global');
        console.log(green(`TRADING HALTED${symbolFlag ? ` for ${symbolFlag}` : ' (global)'} — ${reason}`));
        break;
      }

      case 'resume': {
        const { HaltState } = await import('@dyna/core/cli');
        const hs = new HaltState(join(getStatePath(), 'state'));
        const lifted = hs.resume();
        console.log(green(`Lifted ${lifted} halt(s). Trading may resume.`));
        break;
      }

      case 'pipeline': {
        const pipeMode = getFlagString(parsed.flags, 'mode', globalMode) as 'research' | 'backtest' | 'paper' | 'live';
        await cmdPipeline(runtime, pipeMode);
        break;
      }

      case 'cron': {
        const sub = parsed.positional[0];
        if (!sub) {
          if (parsed.flags['json'] === true) throw new Error('cron subcommand is required');
          console.log(red('Error: cron subcommand is required.'));
        console.log(dim('Usage: dynatrader cron <list|create|update|delete|pause|resume|trigger|inspect|history> [args...] [--json]'));
          process.exit(1);
        }
        await cmdCron(runtime, sub, parsed.positional.slice(1), parsed.flags);
        break;
      }

      case 'kanban': {
        const sub = parsed.positional[0];
        if (!sub) {
          console.log(red('Error: kanban subcommand is required.'));
          console.log(dim('Usage: dynatrader kanban <list|show|create|claim|transition|link> [args...]'));
          process.exit(1);
        }
        await cmdKanban(globalWorkspace, sub, parsed.positional.slice(1));
        break;
      }

      case 'workspace': {
        const sub = parsed.positional[0];
        if (!sub) {
          console.log(red('Error: workspace subcommand is required.'));
          console.log(dim('Usage: dynatrader workspace <list|create|show|validate> [args...]'));
          process.exit(1);
        }
        await cmdWorkspace(globalWorkspace, sub, parsed.positional.slice(1));
        break;
      }

      case 'learning': {
        console.log(yellow('The learning command has been removed.'));
        console.log(dim('Skills and memory are now managed through the skill_manage tool.'));
        break;
      }

      default: {
        console.log(red(`Unknown command: ${command}`));
        console.log(dim('Run "dynatrader --help" for usage.'));
        process.exit(1);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.flags['json'] === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      process.exitCode = 1;
      return;
    }
    console.log();
    console.log(red(`Error: ${message}`));
    console.log();
    process.exit(1);
  } finally {
    // Graceful shutdown
    if (runtime && !shuttingDown) {
      shuttingDown = true;
      try {
        await runtime.shutdown();
      } catch {
        // ignore
      }
    }
  }
}

main();
