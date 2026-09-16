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

import { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import type { TradeMode } from '@dyna/types';

// Shared CLI utilities
import { parseArgs, getFlagString, getFlagNumber, bold, cyan, green, red, yellow, dim, printSeparator } from './cli/utils';
import { join } from 'path';
import { initRuntime } from './cli/runtime-init';
import { getWorkspacePath } from './workspace-init';

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

// =============================================================================
// Command: help
// =============================================================================

function cmdHelp(): void {
  console.log();
  console.log(bold(cyan('DynaTrader CLI')));
  console.log(dim('Trading + DeFi agent runtime with guarded execution and operator controls'));
  printSeparator();

  console.log();
  console.log(bold('USAGE:'));
  console.log('  dynatrader <command> [options]');
  console.log();
  console.log(bold('COMMANDS:'));
  console.log(`  ${green('init')}                    Interactive workspace bootstrap (--yes for non-interactive)`);
  console.log(`  ${green('setup')}                   Validate workspace config and launch scope`);
  console.log(`  ${green('status')}                  Show runtime status and component health`);
  console.log(`  ${green('trade')}                   Run a single agent turn for the current market universe`);
  console.log(`  ${green('backtest')} <symbol>       Run backtest over historical data`);
  console.log(`  ${green('pipeline')}                Run multi-agent trading pipeline`);
  console.log(`  ${green('agents')}                  List loaded agent profiles`);
  console.log(`  ${green('memory')} [query]         Show memory stats or search entries`);
  console.log(`  ${green('compact')}                 Run context compaction`);
  console.log(`  ${green('risk')}                    Show current risk state`);
  console.log(`  ${green('cron')} <sub> [args]       Manage scheduled cron jobs`);
  console.log(`  ${green('mcp')} <sub> [args]        Manage workspace MCP servers`);
  console.log(`  ${green('kanban')} <sub> [args]     Manage kanban task board`);
  console.log(`  ${green('issues')} <sub> [args]     Manage markdown issue board`);
  console.log(`  ${green('track')} <sub> [args]      Manage wikilink tracked entities`);
  console.log(`  ${green('inbox')} <sub> [args]      Read delivered reports and job results`);
  console.log(`  ${green('workspace')} <sub> [args]   Manage trading workspaces`);
  console.log(`  ${green('gateway')} <sub> [args]     Manage daemon lifecycle and gateway connections`);
  console.log(`  ${green('learning')} <sub> [args]    Manage learning loop and skill review`);
  console.log(`  ${green('plugins')} <sub> [args]     Inspect and reload the composed plugin tree`);
  console.log(`  ${green('doctor')}                  Run system diagnostics (--fix for auto-repair)`);
  console.log(`  ${green('logs')} [options]           View daemon logs`);
  console.log(`  ${green('config')} <sub> [args]      Manage configuration`);
  console.log(`  ${green('version')}                  Show version information`);
  console.log(`  ${green('--help')}                  Show this help guide`);
  console.log();

  console.log(bold('CRON SUBCOMMANDS:'));
  console.log(`  list                List all scheduled jobs`);
  console.log(`  add <schedule> <cmd>  Add a new cron job`);
  console.log(`  update <jobId>      Update a cron job`);
  console.log(`  inspect <jobId>     Show full cron job details`);
  console.log(`  remove <jobId>      Remove a cron job`);
  console.log(`  pause <jobId>       Pause a cron job`);
  console.log(`  resume <jobId>      Resume a cron job`);
  console.log(`  trigger <jobId>     Manually trigger a job`);
  console.log(`  run <jobId>         Alias for trigger`);
  console.log();

  console.log(bold('MCP SUBCOMMANDS:'));
  console.log(`  list                List configured MCP servers`);
  console.log(`  inspect <name>      Show a single MCP server config`);
  console.log(`  add <name>          Add a configured MCP server`);
  console.log(`  update <name>       Update a configured MCP server`);
  console.log(`  remove <name>       Remove a configured MCP server`);
  console.log(`  enable <name>       Enable a configured MCP server`);
  console.log(`  disable <name>      Disable a configured MCP server`);
  console.log(`  server              Show MCP server-mode readiness`);
  console.log();

  console.log(bold('KANBAN SUBCOMMANDS:'));
  console.log(`  list [status]       List tasks, optionally filtered by status`);
  console.log(`  show <taskId>       Show task details`);
  console.log(`  create <title>      Create a new task`);
  console.log(`  claim <taskId> [a]  Claim a task for an assignee`);
  console.log(`  transition <id> <s>  Move task to new status`);
  console.log(`  link <from> <to> [t] Link two tasks`);
  console.log();

  console.log(bold('WORKSPACE SUBCOMMANDS:'));
  console.log(`  list                List all workspaces`);
  console.log(`  create <name>       Create a new workspace`);
  console.log(`  show [name]         Show workspace details`);
  console.log(`  validate            Validate current workspace`);
  console.log();

  console.log(bold('GATEWAY SUBCOMMANDS:'));
  console.log(`  run                 Start daemon in foreground (blocking)`);
  console.log(`  start               Start daemon in background via PM2`);
  console.log(`  stop                Stop background daemon (PM2)`);
  console.log(`  restart             Restart background daemon (PM2)`);
  console.log(`  status              Show daemon status and gateway connections`);
  console.log(`  logs [--follow]     View daemon logs (PM2)`);
  console.log(`  monit               Launch PM2 monitoring dashboard`);
  console.log(`  install             Install PM2 startup service`);
  console.log(`  uninstall           Uninstall PM2 startup service`);
  console.log(`  send <target> <msg> Send a message via gateway`);
  console.log();

  console.log(bold('LEARNING SUBCOMMANDS:'));
  console.log(`  skills              List learned skills`);
  console.log(`  recall <query>      Search across sessions`);
  console.log(`  review              Trigger skill review`);
  console.log();

  console.log(bold('COMPACT OPTIONS:'));
  console.log(`  --status            Show compaction configuration`);
  console.log(`  --dynamic           Run with dynamic importance scoring`);
  console.log();

  console.log(bold('CONFIG SUBCOMMANDS:'));
  console.log(`  list                Show all config values`);
  console.log(`  get <key>           Show a specific config value`);
  console.log(`  set <key> <value>   Set a config value`);
  console.log(`  validate            Validate current configuration`);
  console.log();

  console.log(bold('LOGS OPTIONS:'));
  console.log(`  --follow, -f        Tail log output`);
  console.log(`  --lines N, -n N     Number of lines to show (default: 50)`);
  console.log(`  --filter <text>     Filter log entries`);
  console.log();

  console.log(bold('GLOBAL FLAGS:'));
  console.log(`  --mode <paper|research|backtest|live>   Trading mode (default: research)`);
  console.log(`  --workspace <path>                 Workspace directory (default: ~/.dynatrader/)`);
  console.log(`  --runtime <path>                   Workspace path for subsystem commands`);
  console.log(`  --json                             Output in JSON format (future use)`);
  console.log(`  --verbose                          Enable verbose output`);
  console.log(`  --quiet                            Suppress non-essential output`);
  console.log();

  console.log(bold('TRADE OPTIONS:'));
  console.log(`  --mode <paper|research>             Execution mode (default: research)`);
  console.log();

  console.log(bold('BACKTEST OPTIONS:'));
  console.log(`  --timeframe <1m|5m|15m|1h|4h|1d>   Timeframe (required)`);
  console.log(`  --days <N>                          Days of history (default: 30)`);
  console.log(`  --start <ISO date>                  Explicit historical window start`);
  console.log(`  --end <ISO date>                    Explicit historical window end`);
  console.log(`  --venues <a,b,c>                    One or more venues to test`);
  console.log();

  console.log(bold('PIPELINE OPTIONS:'));
  console.log(`  --mode <paper|research|backtest>    Execution mode (default: research)`);
  console.log();

  console.log(bold('EXAMPLES:'));
  console.log(dim('  dynatrader init'));
  console.log(dim('  dynatrader init --yes'));
  console.log(dim('  dynatrader setup'));
  console.log(dim('  dynatrader status'));
  console.log(dim('  dyna trade --mode paper'));
  console.log(dim('  dyna backtest BTC/USDC --timeframe 1d --days 60'));
  console.log(dim('  dyna pipeline --mode research'));
  console.log(dim('  dyna agents'));
  console.log(dim('  dyna memory'));
  console.log(dim('  dyna memory "moving average"'));
  console.log(dim('  dyna risk'));
  console.log(dim('  dyna cron list'));
  console.log(dim('  dyna cron add "every 1h" "analyze markets"'));
  console.log(dim('  dyna mcp list'));
  console.log(dim('  dyna mcp add market-feed --transport http --url https://example.com/mcp'));
  console.log(dim('  dyna kanban list'));
  console.log(dim('  dyna kanban create "Research new strategy"'));
  console.log(dim('  dyna workspace list'));
  console.log(dim('  dyna workspace create "Momentum Research"'));
  console.log(dim('  dyna gateway status'));
  console.log(dim('  dyna gateway start'));
  console.log(dim('  dyna gateway stop'));
  console.log(dim('  dyna gateway restart'));
  console.log(dim('  dyna gateway run --mode paper'));
  console.log(dim('  dyna gateway logs --follow'));
  console.log(dim('  dyna gateway monit'));
  console.log(dim('  dyna gateway install'));
  console.log(dim('  dyna learning skills'));
  console.log(dim('  dyna learning recall "moving average"'));
  console.log(dim('  dyna doctor'));
  console.log(dim('  dyna logs --follow'));
  console.log(dim('  dyna logs --lines 100 --filter error'));
  console.log(dim('  dyna config list'));
  console.log(dim('  dyna config get OPENAI_API_KEY'));
  console.log(dim('  dyna config set risk.maxDrawdown 0.25'));
  console.log(dim('  dyna config validate'));
  console.log(dim('  dyna version'));
  console.log();
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  // --stdio: delegate to the standalone stdio entry point
  // Used by Terminal (and other consumers) to spawn DynaTrader as a child process
  // communicating via JSON-RPC over stdin/stdout.
  if (parsed.flags['stdio'] === true) {
    // Dynamic import so the stdio entry is only loaded when needed
    await import('./entry/stdio.js');
    return;
  }

  // --help with no command
  if (!parsed.command || parsed.flags['help']) {
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
      cmdHelp();
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
      await cmdLogs(globalWorkspace, parsed.flags);
      return;
    }

    if (command === 'config') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.log(red('Error: config subcommand is required.'));
        console.log(dim('Usage: dynatrader config <list|get|set|validate> [key] [value]'));
        process.exit(1);
      }
      await cmdConfig(globalWorkspace, sub, parsed.positional.slice(1));
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
      await cmdGateway(sub, parsed.positional.slice(1), globalWorkspace);
      return;
    }

    if (command === 'mcp') {
      const sub = parsed.positional[0];
      if (!sub) {
        console.log(red('Error: mcp subcommand is required.'));
        console.log(dim('Usage: dynatrader mcp <list|inspect|add|update|remove|enable|disable|server> [args...]'));
        process.exit(1);
      }
      await cmdMcp(globalWorkspace, sub, parsed.positional.slice(1), parsed.flags);
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
        await cmdStatus(runtime, workspace);
        break;
      }

      case 'trade': {
        const tradeMode = getFlagString(parsed.flags, 'mode', globalMode) as TradeMode;
        await cmdTrade(runtime, tradeMode);
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
        const { HaltState } = await import('./runtime/halt/halt-state');
        const reason = parsed.positional.length > 0 ? parsed.positional.join(' ') : 'Halted via CLI';
        const hs = new HaltState(join(globalWorkspace, 'state'));
        const symbolFlag = getFlagString(parsed.flags, 'symbol', '');
        hs.halt(reason, 'cli', symbolFlag ? { symbol: symbolFlag } : 'global');
        console.log(green(`TRADING HALTED${symbolFlag ? ` for ${symbolFlag}` : ' (global)'} — ${reason}`));
        break;
      }

      case 'resume': {
        const { HaltState } = await import('./runtime/halt/halt-state');
        const hs = new HaltState(join(globalWorkspace, 'state'));
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
          console.log(red('Error: cron subcommand is required.'));
          console.log(dim('Usage: dynatrader cron <list|add|update|remove|pause|resume|trigger|run|inspect> [args...]'));
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
