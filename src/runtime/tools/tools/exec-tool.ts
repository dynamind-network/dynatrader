import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

const execFileAsync = promisify(execFile);

const DEFAULT_ALLOWLIST: string[] = [
  'git', 'node', 'python', 'python3', 'ls', 'cat', 'head', 'tail', 'echo',
  'mkdir', 'cp', 'mv', 'rm', 'find', 'grep', 'wc', 'sort', 'uniq',
  'date', 'pwd', 'which', 'curl', 'wget', 'tar', 'unzip', 'gzip', 'gunzip',
  'bun', 'npm', 'npx', 'tsx', 'pnpm', 'yarn',
  // Windows-specific
  'where', 'dir', 'type', 'tasklist',
  // Unix-specific
  'less',
];

// Shell interpreters must never be on the allowlist — they defeat it entirely.
const INTERPRETER_NAMES = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh']);

/**
 * Shell metacharacters that can chain/spawn additional commands.
 * Any command string containing these is rejected before parsing —
 * the allowlist only validates the first token, so `git status & curl evil`
 * would otherwise pass as "git".
 */
const SHELL_METACHARACTERS = /[&|;`$><\n\r]/;

const DEFAULT_BLOCKLIST: string[] = [
  'sudo', 'su', 'chmod', 'chown', 'passwd', 'kill', 'pkill',
  'systemctl', 'service', 'docker', 'kubectl',
  'ssh', 'telnet', 'nc', 'ncat', 'netcat',
  'perl', 'eval', 'python -c', 'python3 -c', 'node -e',
  'bash -c', 'sh -c', 'zsh -c', 'cmd /c', 'cmd.exe /c',
  'powershell -c', 'powershell -command', 'pwsh -c', 'pwsh -command',
];

export interface ExecToolConfig {
  allowlist?: string[];
  blocklist?: string[];
  maxOutputLength?: number;
  defaultCwd?: string;
  workspaceRoot?: string;
}

export class ExecTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'exec',
    description: 'Execute shell commands with sandboxed allowlist',
    category: 'exec',
    inputSchema: { command: 'string', timeout: 'number?', workdir: 'string?' },
    outputSchema: { stdout: 'string', stderr: 'string', exitCode: 'number' },
    permissionsRequired: ['tool.exec'],
    sideEffects: ['executes_commands'],
    riskLevel: 'high',
    timeoutMs: 30000,
  };

  private allowlist: readonly string[];
  private blocklist: readonly string[];
  private maxOutputLength: number;
  private defaultCwd?: string;
  private workspaceRoot: string;

  constructor(config?: ExecToolConfig) {
    this.allowlist = config?.allowlist ?? DEFAULT_ALLOWLIST;
    this.blocklist = config?.blocklist ?? DEFAULT_BLOCKLIST;
    this.maxOutputLength = config?.maxOutputLength ?? 100 * 1024;
    this.defaultCwd = config?.defaultCwd;
    this.workspaceRoot = config?.workspaceRoot ?? config?.defaultCwd ?? process.cwd();
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const command = call.args.command;
      if (typeof command !== 'string' || !command.trim()) {
        return {
          success: false,
          error: 'Command must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const trimmedCommand = command.trim();

      // Reject shell metacharacters BEFORE any allowlist check — the allowlist
      // only inspects the first token, so chained commands would slip through.
      if (SHELL_METACHARACTERS.test(trimmedCommand)) {
        return {
          success: false,
          error: 'Command rejected: shell metacharacters (& | ; ` $ > <) are not permitted. Run one command at a time.',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const cmdName = this.parseCommandName(trimmedCommand);
      if (!cmdName) {
        return {
          success: false,
          error: 'Could not parse command name from command string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (!this.isAllowed(trimmedCommand, cmdName)) {
        return {
          success: false,
          error: `Command '${cmdName}' is not allowed`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (INTERPRETER_NAMES.has(cmdName.toLowerCase())) {
        return {
          success: false,
          error: `Command rejected: '${cmdName}' is a shell interpreter and cannot be executed via exec.`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const timeout = (call.args.timeout as number | undefined) ?? this.definition.timeoutMs;
      const workdir = this.resolveWorkdir(call.args.workdir as string | undefined);

      const isWin = process.platform === 'win32';

      let stdout: string;
      let stderr: string;

      if (isWin) {
        // Split into argv and run via execFile directly — never cmd.exe /c,
        // which re-interprets the whole string through the shell.
        const parts = this.parseCommand(trimmedCommand);
        const cmd = parts[0];
        if (!cmd) {
          return {
            success: false,
            error: 'Could not parse command',
            durationMs: Date.now() - start,
            truncated: false,
          };
        }
        const args = parts.slice(1);
        // On Windows, .cmd/.bat shims (npm, npx, etc.) need the shell; resolve
        // them explicitly via cmd.exe ONLY when the extension requires it.
        const needsShell = /\.(cmd|bat|com)$/i.test(cmd);
        const result = needsShell
          ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], {
              timeout,
              cwd: workdir,
              maxBuffer: this.maxOutputLength + 4096,
              windowsHide: true,
            })
          : await execFileAsync(cmd, args, {
              timeout,
              cwd: workdir,
              maxBuffer: this.maxOutputLength + 4096,
              windowsHide: true,
            });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
      } else {
        const parts = this.parseCommand(trimmedCommand);
        const cmd = parts[0];
        if (!cmd) {
          return {
            success: false,
            error: 'Could not parse command',
            durationMs: Date.now() - start,
            truncated: false,
          };
        }
        const args = parts.slice(1);
        const result = await execFileAsync(cmd, args, {
          timeout,
          cwd: workdir,
          maxBuffer: this.maxOutputLength + 4096,
        });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
      }

      const truncated = stdout.length > this.maxOutputLength || stderr.length > this.maxOutputLength;
      const truncatedStdout = stdout.length > this.maxOutputLength
        ? stdout.slice(0, this.maxOutputLength) + '\n... [truncated]'
        : stdout;
      const truncatedStderr = stderr.length > this.maxOutputLength
        ? stderr.slice(0, this.maxOutputLength) + '\n... [truncated]'
        : stderr;

      return {
        success: true,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        durationMs: Date.now() - start,
        truncated,
      };
    } catch (err: unknown) {
      const error = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string; code?: string | number };
      const capturedStdout = typeof error.stdout === 'string'
        ? error.stdout
        : error.stdout instanceof Buffer
          ? error.stdout.toString()
          : '';
      const capturedStderr = typeof error.stderr === 'string'
        ? error.stderr
        : error.stderr instanceof Buffer
          ? error.stderr.toString()
          : '';

      return {
        success: false,
        error: (err as Error).message ?? String(err),
        stdout: capturedStdout,
        stderr: capturedStderr,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private parseCommandName(command: string): string | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(?:([a-zA-Z]\S*?)(?:\.exe|\.cmd|\.bat)?)(?:\s|$)/);
    if (match) return match[1]?.toLowerCase() ?? null;
    const fallback = trimmed.split(/\s+/)[0];
    return fallback?.toLowerCase() ?? null;
  }

  private parseCommand(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (let i = 0; i < command.length; i++) {
      const char = command[i];
      if (!char) continue;

      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === ' ') {
        if (current.length > 0) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current.length > 0) {
      args.push(current);
    }

    return args;
  }

  private resolveWorkdir(workdir: string | undefined): string | undefined {
    if (!workdir) {
      return this.defaultCwd;
    }

    const resolved = path.isAbsolute(workdir)
      ? path.normalize(workdir)
      : path.resolve(this.workspaceRoot, workdir);
    this.validateWorkdir(resolved);
    return resolved;
  }

  private validateWorkdir(resolved: string): void {
    const normalizedResolved = path.normalize(resolved);
    const normalizedRoot = path.normalize(path.resolve(this.workspaceRoot));

    if (
      normalizedResolved !== normalizedRoot &&
      !normalizedResolved.startsWith(normalizedRoot + path.sep)
    ) {
      throw new Error(
        `Workdir traversal blocked: '${resolved}' is not within the workspace root '${normalizedRoot}'`,
      );
    }
  }

  private isAllowed(command: string, cmdName: string): boolean {
    const lower = cmdName.toLowerCase();
    const normalizedCommand = command.trim().toLowerCase();
    // Remove file extensions for comparison
    const baseName = lower.replace(/\.(exe|cmd|bat)$/, '');

    // Check blocklist first
    for (const blocked of this.blocklist) {
      const blockedLower = blocked.toLowerCase();
      const blockedBase = blockedLower.replace(/\.(exe|cmd|bat)$/, '');
      if (baseName === blockedBase) return false;
      if (
        normalizedCommand === blockedLower ||
        normalizedCommand.startsWith(`${blockedLower} `)
      ) {
        return false;
      }
    }

    // Check allowlist
    for (const allowed of this.allowlist) {
      const allowedLower = allowed.toLowerCase();
      if (baseName === allowedLower) return true;
      if (lower === allowedLower) return true; // exact match including extension
    }

    return false;
  }
}
