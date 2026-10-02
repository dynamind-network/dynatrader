#!/usr/bin/env node

/**
 * DynaTrader Unified CLI — Dispatcher.
 *
 * Usage:
 *   dynatrader              Launch terminal UI (default)
 *   dynatrader --tui        Launch terminal UI
 *   dynatrader --cli        Classic CLI (operational commands)
 *   dynatrader --stdio      JSON-RPC gateway (stdin/stdout)
 *   dynatrader --dev        Development mode
 *   dynatrader <command>    Operational command (status, trade, etc.)
 *
 * Interface selection follows the model:
 * - Default (no args) → TUI
 * - --tui → TUI (explicit)
 * - --cli → classic CLI
 * - --stdio → JSON-RPC gateway
 * - Operational commands → dispatch to cli.ts
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { CLI_COMMANDS } from '../cli/commands/help';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPkg(): { version: string } {
  return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
}

// ── Argv parsing ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const args = {
  tui: false,
  cli: false,
  stdio: false,
  noDaemon: false,
  dev: false,
  help: false,
  version: false,
  oneshot: false,
  prompt: null as string | null,
  model: null as string | null,
  session: null as string | null,
  resume: false,
  continueSession: false,
  command: null as string | null,
  commandArgs: [] as string[],
};

// Separate flags from positional args
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--tui') args.tui = true;
  else if (arg === '--cli') args.cli = true;
  else if (arg === '--stdio') args.stdio = true;
  else if (arg === '--no-daemon') args.noDaemon = true;
  else if (arg === '--dev') args.dev = true;
  else if (arg === '-h' || arg === '--help') args.help = true;
  else if (arg === '-v' || arg === '--version') args.version = true;
  else if (arg === '-z' || arg === '--oneshot') args.oneshot = true;
  else if (arg === '-p' || arg === '--prompt') {
    args.prompt = argv[++i] ?? null;
  } else if (arg === '-m' || arg === '--model') {
    args.model = argv[++i] ?? null;
  } else if (arg === '-s' || arg === '--session') {
    const sessionId = argv[i + 1];
    if (sessionId && !sessionId.startsWith('-')) {
      args.session = sessionId;
      i++;
    }
  } else if (arg?.startsWith('--session=')) {
    args.session = arg.slice('--session='.length) || null;
  } else if (arg === '--resume') {
    args.resume = true;
    const sessionId = argv[i + 1];
    if (sessionId && !sessionId.startsWith('-')) {
      args.session = sessionId;
      i++;
    }
  } else if (arg?.startsWith('--resume=')) {
    args.resume = true;
    args.session = arg.slice('--resume='.length) || null;
  }
  else if (arg === '-c' || arg === '--continue') args.continueSession = true;
  else if (arg === '--skills' || arg === '--yolo' || arg === '--connect') {
    // Skip next arg (flag with value)
    i++;
  } else if (arg.startsWith('-')) {
    // Unknown flag — skip
  } else {
    positional.push(arg);
  }
}

if (positional.length > 0) {
  args.command = positional[0];
  args.commandArgs = positional.slice(1);
}

// ── Version ─────────────────────────────────────────────────────────────────

if (args.version) {
  console.log(`dynatrader ${readPkg().version}`);
  process.exit(0);
}

// ── Help ────────────────────────────────────────────────────────────────────

if (args.help && !args.command) {
  const pkg = readPkg();
  console.log(`
DynaTrader ${pkg.version} — trading + DeFi AI agent runtime

USAGE
  dynatrader [flags]           Launch terminal UI (default)
  dynatrader <command> [args]  Run operational command

INTERFACE FLAGS
  --tui          Launch terminal UI (default)
  --cli          Classic CLI mode
  --stdio        JSON-RPC gateway (stdin/stdout)
  --no-daemon    Use the local standalone coding agent runtime
  --dev          Development mode

OPTIONS
  -m, --model    Override model provider
  -s, --session  Session ID to resume
  -p, --prompt   Send a prompt and exit (--oneshot)
  -c, --continue Resume the most recently updated session
  --resume <id>  Resume a specific session
  -z, --oneshot  Non-interactive mode
  -v, --version  Print version
  -h, --help     Show this help

COMMANDS
${CLI_COMMANDS.map((command) => `  ${command.name.padEnd(14)} ${command.description}`).join('\n')}

  --json         Supported by status, doctor, gateway status, and cron commands

ENVIRONMENT
  DYNATRADER_ENTRY    Override stdio entry point
  DYNATRADER_MODEL   Override model provider
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key
`);
  process.exit(0);
}

if (args.resume && !args.session) {
  console.error('dynatrader: --resume requires a session ID. Use --continue to resume the latest session.');
  process.exit(2);
}

// ── Resolve terminal entry ──────────────────────────────────────────────────

function resolveTerminalEntry(): string | null {
  // Resolve the published UI through its package export. This is the normal
  // path for npm consumers and does not assume sibling package layouts.
  try {
    // The UI exposes this entry through the ESM "import" condition only, so
    // require.resolve cannot resolve it from a clean npm installation.
    const packageEntry = fileURLToPath(import.meta.resolve('@dynatrader/ui/cli'));
    if (existsSync(packageEntry)) return packageEntry;
  } catch {
    // Fall through to the staged UI path for repository development.
  }

  const candidates = [resolve(__dirname, '../../../ui/dist/cli.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Resolve operational CLI ─────────────────────────────────────────────────

function resolveOperationalCli(): string | null {
  const candidates = [
    resolve(__dirname, '../cli.ts'),
    resolve(__dirname, '../cli.js'),
    resolve(__dirname, '../index.ts'),
    resolve(__dirname, '../index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Spawn helper ────────────────────────────────────────────────────────────

function spawnChild(entry: string, extraArgs: string[] = [], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, ...extraArgs], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // --stdio → JSON-RPC gateway
  if (args.stdio) {
    const entry = resolve(__dirname, './stdio.js');
    if (!existsSync(entry)) {
      console.error('dynatrader: stdio entry not found. Run `bun run build` first.');
      process.exit(1);
    }
    const code = await spawnChild(entry);
    process.exit(code);
  }

  // Operational command → dispatch to cli.ts
  if (args.command && !args.tui && !args.cli) {
    // Pass all args through to the operational CLI
    const entry = resolveOperationalCli();
    if (entry) {
      const code = await spawnChild(entry, process.argv.slice(2));
      process.exit(code);
    }
    console.error(`dynatrader: unknown command "${args.command}". Run "dynatrader --help" for usage.`);
    process.exit(1);
  }

  // --cli → classic CLI mode (interactive REPL)
  if (args.cli) {
    const entry = resolveOperationalCli();
    if (entry) {
      const code = await spawnChild(entry, ['chat', ...args.commandArgs]);
      process.exit(code);
    }
    console.error('dynatrader: operational CLI not found. Run `bun run build` first.');
    process.exit(1);
  }

  // Default → TUI
  const terminalEntry = resolveTerminalEntry();
  if (!terminalEntry) {
    console.error('dynatrader: terminal UI not found. Run `bun run build:ui` first.');
    process.exit(1);
  }

  const env: NodeJS.ProcessEnv = {};
  if (args.model) env['DYNATRADER_MODEL'] = args.model;
  if (args.session) env['DYNATRADER_SESSION'] = args.session;
  if (args.continueSession) env['DYNATRADER_CONTINUE'] = 'true';
  if (args.noDaemon) env['DYNATRADER_NO_DAEMON'] = 'true';
  if (args.oneshot) env['DYNATRADER_ONESHOT'] = 'true';
  if (args.prompt) env['DYNATRADER_PROMPT'] = args.prompt;
  if (args.dev) env['DYNATRADER_DEV'] = 'true';

  const terminalArgs = process.argv.slice(2).filter((arg) => arg !== '--tui');
  if (args.oneshot) {
    const oneshotIndex = terminalArgs.findIndex((arg) => arg === '--oneshot' || arg === '-z');
    if (oneshotIndex >= 0) terminalArgs.splice(oneshotIndex, 1, '--no-tui');
  }
  const code = await spawnChild(terminalEntry, terminalArgs, env);
  process.exit(code);
}

main().catch((error) => {
  console.error(`dynatrader: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});


