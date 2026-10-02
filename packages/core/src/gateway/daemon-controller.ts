/**
 * DaemonController - Manages the lifecycle of the DynaTrader background daemon
 * process via PM2. Replaces manual child_process spawn/PID-file management
 * with PM2 CLI commands for lifecycle management.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';

const PM2_APP_NAME = 'dynatrader';

/**
 * Allowlist of valid PM2 subcommands. Any command passed to pm2Exec
 * is validated against this list to prevent command injection.
 * Reference: https://pm2.keymetrics.io/docs/usage/pm2-doc-single-page/
 */
const ALLOWED_PM2_COMMANDS = new Set([
  'status', 'list', 'monit', 'start', 'stop', 'restart', 'delete',
  'save', 'describe', 'show', 'pid', 'pretty', 'jlist', 'slmt',
  'startup', 'unstartup', 'logs',
]);

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime: number | null;
  restarts: number;
  memory: number | null;
  status: string;
  name: string;
}

export class DaemonController {
  private readonly _packageRoot: string;
  private readonly _ecosystemPath: string;

  /**
   * @param workspacePath - Path to the daemon workspace directory.
   */
  constructor(private workspacePath: string) {
    this._packageRoot = resolve(workspacePath, '..');
    this._ecosystemPath = join(this._packageRoot, 'ecosystem.config.cjs');
  }

  /** Full path to the ecosystem config file. */
  get ecosystemPath(): string {
    return this._ecosystemPath;
  }

  // ---------------------------------------------------------------------------
  // PM2 CLI helper
  // ---------------------------------------------------------------------------

  /**
   * Execute a PM2 CLI command and return the raw output string.
   * Uses --no-color to strip ANSI codes for easier parsing.
   */
  private pm2Exec(command: string): string {
    // Validate command against allowlist to prevent command injection
    const trimmed = command.trim();
    const baseCommand = trimmed.split(/\s+/)[0];
    if (!baseCommand || !ALLOWED_PM2_COMMANDS.has(baseCommand)) {
      throw new Error(`Invalid PM2 command: "${baseCommand ?? ''}". Must be one of: ${[...ALLOWED_PM2_COMMANDS].join(', ')}`);
    }
    // Also reject shell metacharacters in the argument portion to prevent injection
    const argsPortion = trimmed.slice(baseCommand.length).trim();
    if (argsPortion && /[;|&`$(){}<>!#*?\[\]~\\]/.test(argsPortion)) {
      throw new Error(`Invalid PM2 command arguments: shell metacharacters are not allowed in "${argsPortion}"`);
    }

    try {
      const result = execSync(`pm2 ${command} --no-color`, {
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PM2_HOME: process.env.PM2_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.pm2'),
        },
      });
      return result;
    } catch (err: unknown) {
      // pm2 exits non-zero when app is not found -- treat as "not running"
      if (err && typeof err === 'object' && 'stderr' in err) {
        return (err as { stderr: string }).stderr || '';
      }
      return '';
    }
  }

  /**
   * Execute a PM2 CLI command that returns JSON and parse the result.
   */
  private pm2Json(command: string): unknown {
    const output = this.pm2Exec(command);
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check whether the daemon is currently running via PM2.
   */
  async isRunning(): Promise<boolean> {
    const status = await this.getStatus();
    return status.running;
  }

  /**
   * Start the daemon via PM2 using the ecosystem config file.
   *
   * @returns `true` if started, `false` if already running.
   */
  async start(): Promise<boolean> {
    if (await this.isRunning()) return false;

    // Verify ecosystem config exists
    if (!existsSync(this._ecosystemPath)) {
      throw new Error(
        `PM2 ecosystem config not found at ${this._ecosystemPath}. ` +
        'Run "bun run build" first to create dist/daemon.js.'
      );
    }

    // Verify built output exists
    const distPath = join(this._packageRoot, 'dist', 'daemon.js');
    if (!existsSync(distPath)) {
      throw new Error(
        `Built daemon not found at ${distPath}. Run "bun run build" first.`
      );
    }

    // Start via PM2
    const output = this.pm2Exec(`start "${this._ecosystemPath.replace(/\\/g, '/')}"`);
    if (!output.includes('online') && !output.includes('already')) {
      throw new Error(`PM2 start failed: ${output}`);
    }

    return true;
  }

  /**
   * Stop the daemon via PM2.
   *
   * @returns `true` if stopped, `false` if not running.
   */
  async stop(): Promise<boolean> {
    if (!(await this.isRunning())) return false;

    this.pm2Exec(`stop ${PM2_APP_NAME}`);
    return true;
  }

  /**
   * Restart the daemon via PM2.
   *
   * @returns `true` if successfully restarted.
   */
  async restart(): Promise<boolean> {
    // Stop first, then start (ensures clean restart)
    await this.stop();
    await this.delay(500);
    return this.start();
  }

  /**
   * Get detailed daemon status from PM2.
   */
  async getStatus(): Promise<DaemonStatus> {
    const result = this.pm2Json(`jlist`) as Array<Record<string, unknown>> | null;

    if (!Array.isArray(result)) {
      return {
        running: false,
        pid: null,
        uptime: null,
        restarts: 0,
        memory: null,
        status: 'stopped',
        name: PM2_APP_NAME,
      };
    }

    const app = result.find((p) => p.name === PM2_APP_NAME);
    if (!app) {
      return {
        running: false,
        pid: null,
        uptime: null,
        restarts: 0,
        memory: null,
        status: 'stopped',
        name: PM2_APP_NAME,
      };
    }

    const pm2Status = (app.pm2_env as Record<string, unknown>)?.status as string || 'stopped';
    const pid = (app.pid as number) || null;
    const uptime = (app.pm2_env as Record<string, unknown>)?.pm_uptime as number || null;
    const restarts = (app.pm2_env as Record<string, unknown>)?.restart_time as number || 0;
    const memory = (app.monit as Record<string, unknown>)?.memory as number || null;

    return {
      running: pm2Status === 'online',
      pid,
      uptime: uptime ? Date.now() - uptime : null,
      restarts,
      memory,
      status: pm2Status,
      name: PM2_APP_NAME,
    };
  }

  /**
   * Print instructions for installing DynaTrader as a PM2 startup service.
   */
  async install(): Promise<void> {
    const isWin = platform() === 'win32';

    console.log('Installing DynaTrader as a PM2 startup service...');
    console.log('');

    if (isWin) {
      // PM2 startup on Windows
      console.log('Running: pm2-startup install');
      const output = this.pm2Exec('startup');
      console.log(output);

      console.log('Then save the current process list:');
      console.log('  pm2 save');
      console.log('');
      console.log('To uninstall:');
      console.log('  pm2 unstartup');
      console.log('  pm2 delete dynatrader');
    } else {
      // PM2 startup on Linux/macOS
      console.log('Running: pm2 startup');
      const output = this.pm2Exec('startup');
      console.log(output);

      console.log('');
      console.log('Then save the current process list:');
      console.log('  pm2 save');
      console.log('');
      console.log('To uninstall:');
      console.log('  pm2 unstartup');
      console.log('  pm2 delete dynatrader');
    }
  }

  /**
   * Print instructions for uninstalling the PM2 startup service.
   */
  async uninstall(): Promise<void> {
    console.log('Uninstalling PM2 startup service...');
    console.log('');

    this.pm2Exec('unstartup');
    console.log('PM2 startup service removed.');
    console.log('');
    console.log('To also stop the daemon:');
    console.log('  pm2 delete dynatrader');
  }

  // ---------------------------------------------------------------------------
  // Log access
  // ---------------------------------------------------------------------------

  /**
   * Get the PM2 log file paths for the daemon.
   */
  getLogPaths(): { out: string; err: string; combined: string } {
    const pm2Home = process.env.PM2_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.pm2');
    return {
      out: join(pm2Home, 'dynatrader-out.log'),
      err: join(pm2Home, 'dynatrader-error.log'),
      combined: join(pm2Home, 'dynatrader.log'),
    };
  }

  /**
   * Stream PM2 logs for the daemon to stdout/stderr.
   * This is a blocking call that tails the PM2 logs.
   */
  streamLogs(lines: number = 200): void {
    try {
      const child = require('child_process').spawn('pm2', ['logs', PM2_APP_NAME, '--lines', String(lines), '--nostream'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (data: Buffer) => {
        process.stdout.write(data);
      });

      child.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });

      child.on('exit', () => {
        process.exit(0);
      });
    } catch {
      // Fallback: just show the log file paths
      const paths = this.getLogPaths();
      console.log('Log files:');
      console.log(`  Output:   ${paths.out}`);
      console.log(`  Error:    ${paths.err}`);
      console.log(`  Combined: ${paths.combined}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
