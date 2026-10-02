/**
 * CLI Command: gateway
 */

import { DaemonController } from '@dyna/core/cli';
import { buildGatewayRuntimeStatus, listGatewayTargets, sendGatewayMessage, TelegramGateway, TELEGRAM_MENU_COMMANDS } from '@dyna/core/cli';
import { loadConfig, saveConfig } from '@dyna/core/cli';
import { bold, cyan, green, red, yellow, dim, formatDuration, printSeparator } from '../utils';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';

function parseTelegramAllowlist(value: string): number[] {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^-?\d+$/.test(part))) {
    throw new Error('Enter one or more numeric Telegram chat IDs separated by commas.');
  }
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id === 0)) {
    throw new Error('Telegram chat IDs must be non-zero safe integers.');
  }
  return [...new Set(ids)];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function setupTelegram(workspacePath: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in your environment, then rerun `dynatrader gateway telegram setup`. The token is never written to config.yaml.');

  const gateway = new TelegramGateway();
  await gateway.initialize({ token, sendOnly: true });
  const bot = await gateway.getMe();
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`Connected to @${bot.username ?? bot.first_name ?? bot.id}.`);
    console.log('In Telegram, open a private chat or group with the bot and send /start. Then enter the numeric chat ID(s) to allow.');
    const entered = await terminal.question('Allowed chat IDs (comma-separated): ');
    const allowedChatIds = parseTelegramAllowlist(entered);
    for (const chatId of allowedChatIds) {
      await gateway.getChat(chatId);
    }
    const enteredDefault = await terminal.question(`Default outbound chat ID [${allowedChatIds[0]}]: `);
    const defaultChatId = enteredDefault.trim() || String(allowedChatIds[0]);
    if (!/^-?\d+$/.test(defaultChatId) || !allowedChatIds.includes(Number(defaultChatId))) {
      throw new Error('The default chat must be one of the allowed chat IDs.');
    }

    const config = await loadConfig(workspacePath);
    config.gateway.telegram.enabled = true;
    config.gateway.telegram.allowedChatIds = allowedChatIds;
    config.gateway.telegram.defaultChatId = defaultChatId;
    delete config.gateway.telegram.token;
    await saveConfig(workspacePath, config);
    const menuUpdated = await gateway.setMyCommands(TELEGRAM_MENU_COMMANDS);
    console.log(green(`Telegram is ready for ${allowedChatIds.length} allowed chat(s).`));
    console.log(menuUpdated
      ? green('Basic Telegram commands registered; runtime-specific commands will appear when the daemon starts.')
      : yellow('Allowlist saved, but Telegram command menu registration failed.'));
    console.log(dim('The bot token remains in TELEGRAM_BOT_TOKEN; config.yaml stores only chat IDs and the default destination.'));
  } finally {
    terminal.close();
    await gateway.stop().catch(() => {});
  }
}

function resolveDaemonEntrypoint(): { command: string; args: string[] } {
  const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)));
  const bundledDaemon = join(moduleDir, 'daemon.js');
  const sourceDaemon = join(moduleDir, '..', '..', 'daemon.ts');
  const registerScript = join(moduleDir, '..', '..', 'scripts', 'register-aliases.mjs');

  if (existsSync(bundledDaemon)) {
    return { command: 'node', args: [bundledDaemon] };
  }

  if (existsSync(sourceDaemon)) {
    return { command: 'node', args: ['--import', 'tsx/esm', '--import', registerScript, sourceDaemon] };
  }

  return { command: 'node', args: ['--import', 'tsx/esm', '--import', registerScript, sourceDaemon] };
}

export async function cmdGateway(
  sub: string,
  args: string[],
  workspacePath: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const daemon = new DaemonController(workspacePath);

  switch (sub) {
    case 'telegram': {
      if (args[0] !== 'setup') {
        console.log(yellow('Usage: dynatrader gateway telegram setup'));
        return;
      }
      try {
        await setupTelegram(workspacePath);
      } catch (error) {
        console.log(red(`Telegram setup failed: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
      break;
    }

    case 'run': {
      const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] ?? 'paper' : 'paper';
      const ws = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] ?? workspacePath : workspacePath;

      console.log();
      console.log(bold(cyan('Starting daemon in foreground...')));
      console.log(dim(`  Mode: ${mode}`));
      console.log(dim(`  Workspace: ${resolve(ws)}`));
      console.log();

      const logDir = join(ws, 'logs');
      await mkdir(logDir, { recursive: true });

      const { command, args: cmdArgs } = resolveDaemonEntrypoint();

      const child = spawn(command, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DYNA_WORKSPACE: resolve(ws),
          DYNA_MODE: mode,
        },
      });

      child.stdout?.on('data', (data: Buffer) => {
        process.stdout.write(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(red(data.toString()));
      });

      child.on('exit', (code) => {
        console.log(dim(`\nDaemon exited with code ${code ?? 'unknown'}`));
        process.exit(code ?? 0);
      });

      const cleanup = (): void => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      await new Promise<void>(() => {});
      break;
    }

    case 'start': {
      console.log();
      console.log(bold(cyan('Starting daemon via PM2...')));
      printSeparator();

      try {
        const started = await daemon.start();
        if (started) {
          const status = await daemon.getStatus();
          console.log(green(`Daemon started via PM2 (PID: ${status.pid})`));
          console.log(dim(`  Uptime: ${formatDuration(status.uptime ?? 0)}`));
          console.log(dim(`  Logs: pm2 logs dynatrader`));
        } else {
          const status = await daemon.getStatus();
          console.log(yellow(`Daemon already running (PID: ${status.pid})`));
        }
      } catch (err: unknown) {
        console.log(red(`Failed to start daemon: ${err instanceof Error ? err.message : err}`));
        console.log(dim('Make sure to run "bun run build" first.'));
      }
      console.log();
      break;
    }

    case 'stop': {
      console.log();
      console.log(bold(cyan('Stopping daemon via PM2...')));
      printSeparator();

      const stopped = await daemon.stop();
      if (stopped) {
        console.log(green('Daemon stopped via PM2'));
      } else {
        console.log(yellow('Daemon not running'));
      }
      console.log();
      break;
    }

    case 'restart': {
      console.log();
      console.log(bold(cyan('Restarting daemon via PM2...')));
      printSeparator();

      try {
        await daemon.restart();
        const status = await daemon.getStatus();
        if (status.running) {
          console.log(green(`Daemon restarted via PM2 (PID: ${status.pid})`));
        } else {
          console.log(red('Daemon failed to restart'));
        }
      } catch (err: unknown) {
        console.log(red(`Failed to restart daemon: ${err instanceof Error ? err.message : err}`));
      }
      console.log();
      break;
    }

    case 'status': {
      const config = await loadConfig(workspacePath);
      const gatewayStatus = buildGatewayRuntimeStatus(config as any, process.env);
      const daemonStatus = await daemon.getStatus();
      if (options.json) {
        console.log(JSON.stringify({
          daemon: {
            running: daemonStatus.running,
            pid: daemonStatus.pid,
            uptime: daemonStatus.uptime,
            restarts: daemonStatus.restarts,
            memory: daemonStatus.memory,
            name: 'dynatrader',
          },
          gateway: gatewayStatus,
        }, null, 2));
        break;
      }

      console.log();
      console.log(bold(cyan('Gateway Status (PM2)')));
      printSeparator();
      if (daemonStatus.running) {
        console.log(`  Daemon:    ${green('online')} (PID: ${daemonStatus.pid})`);
        if (daemonStatus.uptime !== null) {
          console.log(`  Uptime:    ${formatDuration(daemonStatus.uptime)}`);
        }
        console.log(`  Restarts:  ${daemonStatus.restarts}`);
        if (daemonStatus.memory !== null) {
          console.log(`  Memory:    ${Math.round(daemonStatus.memory / 1024 / 1024)} MB`);
        }
      } else {
        console.log(`  Daemon:    ${red('stopped')}`);
      }
      console.log(`  PM2 Name:  dynatrader`);
      console.log(`  Ecosystem: ${dim(daemon.ecosystemPath)}`);
      console.log();

      console.log(bold('  Gateway Readiness:'));
      console.log(`    Telegram: ${gatewayStatus.telegram.configured ? green('ready') : yellow('not ready')}`);
      console.log(`      ${dim(gatewayStatus.telegram.detail)}`);
      console.log(`    Discord:  ${gatewayStatus.discord.configured ? green('ready') : yellow('not ready')}`);
      console.log(`      ${dim(gatewayStatus.discord.detail)}`);
      console.log(`    Chat:     ${gatewayStatus.agentChat.configured ? green('ready') : yellow('not ready')}`);
      console.log(`      ${dim(gatewayStatus.agentChat.detail)}`);
      console.log();
      break;
    }

    case 'logs': {
      const lines = args.includes('--lines') || args.includes('-n')
        ? parseInt(args[args.includes('--lines') ? args.indexOf('--lines') + 1 : args.indexOf('-n') + 1] ?? '100', 10)
        : 100;

      if (args.includes('--follow') || args.includes('-f')) {
        console.log(dim(`Streaming PM2 logs for dynatrader (Ctrl+C to stop)...`));
        console.log();
        daemon.streamLogs(50);
        await new Promise<void>(() => {});
      } else {
        const logPaths = daemon.getLogPaths();
        console.log();
        console.log(bold(cyan('Daemon Logs (PM2)')));
        printSeparator();
        console.log(`  Output:   ${logPaths.out}`);
        console.log(`  Error:    ${logPaths.err}`);
        console.log(`  Combined: ${logPaths.combined}`);
        console.log();
        console.log(dim(`  View logs: pm2 logs dynatrader --lines ${lines}`));
        console.log(dim(`  Follow:    pm2 logs dynatrader --follow`));
        console.log(dim(`  Clear:     pm2 flush dynatrader`));
        console.log();
      }
      break;
    }

    case 'monit': {
      console.log();
      console.log(bold(cyan('Launching PM2 Monitor...')));
      console.log(dim('Press Ctrl+C to exit'));
      console.log();
      const { execSync } = await import('child_process');
      try {
        execSync('pm2 monit', { stdio: 'inherit' });
      } catch {
        console.log(dim('PM2 monit exited.'));
      }
      break;
    }

    case 'install': {
      console.log();
      console.log(bold(cyan('Daemon Service Installation (PM2 Startup)')));
      printSeparator();
      await daemon.install();
      console.log();
      break;
    }

    case 'uninstall': {
      console.log();
      console.log(bold(cyan('Daemon Service Uninstallation (PM2 Startup)')));
      printSeparator();
      await daemon.uninstall();
      console.log();
      break;
    }

    case 'send': {
      if (args[0] === '--list' || args[0] === 'list') {
        const config = await loadConfig(workspacePath);
        const targets = listGatewayTargets(config as any, process.env);
        console.log(targets.length ? targets.map((target) => `  ${target}`).join('\n') : 'No configured gateway targets.');
        return;
      }
      const channel = args[0];
      if (!channel) {
        console.log(red('Error: channel and message are required.'));
        console.log(dim('Usage: dynatrader gateway send <target[,target...]> <message> [--file <path>|--stdin] | --list'));
        return;
      }

      let filePath: string | undefined;
      let useStdin = false;
      const messageParts: string[] = [];
      for (let index = 1; index < args.length; index++) {
        if (args[index] === '--file') {
          filePath = args[++index];
          if (!filePath) throw new Error('--file requires a path');
        } else if (args[index] === '--stdin' || args[index] === '-') {
          useStdin = true;
        } else {
          messageParts.push(args[index]!);
        }
      }
      if (filePath && useStdin) throw new Error('Choose either --file or --stdin for the message source.');
      let file: { filename: string; data: Uint8Array } | undefined;
      let message: string | undefined;
      if (filePath) {
        file = { filename: basename(filePath), data: new Uint8Array(await readFile(resolve(filePath))) };
      } else if (useStdin) {
        message = await readStdin();
      } else {
        message = messageParts.join(' ');
      }
      if (!file && !message?.trim()) {
        console.log(red('Error: provide text, --file <path>, or --stdin.'));
        return;
      }

      const config = await loadConfig(workspacePath);
      try {
        const targets = channel.split(',').map((target) => target.trim()).filter(Boolean);
        const results = await Promise.all(targets.map((target) => sendGatewayMessage({ target, message, file }, config as any, process.env)));
        console.log(green(`Sent via ${results.join(', ')}`));
      } catch (error) {
        console.log(red(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`));
        console.log(dim('Use an explicit telegram:<chatId> or discord:<channelId> target, or set a default channel in config.yaml.'));
      }
      break;
    }

    default: {
      console.log(red(`Unknown gateway subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader gateway <run|start|stop|restart|status|logs|monit|install|uninstall|send> [args...]'));
    }
  }
}
