/**
 * CLI Command: gateway
 */

import { DaemonController } from '../../gateway/daemon-controller';
import { buildGatewayRuntimeStatus, sendGatewayMessage } from '../../gateway/runtime-gateway';
import { loadConfig } from '../../config';
import { bold, cyan, green, red, yellow, dim, formatDuration, printSeparator } from '../utils';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

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
): Promise<void> {
  const daemon = new DaemonController(workspacePath);

  switch (sub) {
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
      console.log();
      console.log(bold(cyan('Gateway Status (PM2)')));
      printSeparator();

      const config = await loadConfig(workspacePath);
      const gatewayStatus = buildGatewayRuntimeStatus(config as any, process.env);

      const daemonStatus = await daemon.getStatus();
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
      const channel = args[0];
      const message = args.slice(1).join(' ');
      if (!channel || !message) {
        console.log(red('Error: channel and message are required.'));
        console.log(dim('Usage: dynatrader gateway send <telegram:<chatId>|discord:<channelId>> <message>'));
        return;
      }

      const config = await loadConfig(workspacePath);
      try {
        const deliveredTo = await sendGatewayMessage({ target: channel, message }, config as any, process.env);
        console.log(green(`Message sent via ${deliveredTo}`));
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
