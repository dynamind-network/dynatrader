import { spawn } from 'child_process';
import { accessSync, statSync, constants as fsConstants } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseTool, ToolKind } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { PathSecurity } from './path-security.js';
import { getErrorMessage } from '../utils/index.js';

const FILE_OPS = new Set([
  'rm',
  'cp',
  'mv',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'cat',
  'get-content',
  'set-content',
  'add-content',
  'copy-item',
  'move-item',
  'remove-item',
  'new-item',
  'rename-item',
]);

const CWD_OPS = new Set(['cd', 'push-location', 'set-location', 'pwd']);

const DANGEROUS_OPS = new Set([
  'rm',
  'del',
  'rmdir',
  'remove-item',
  'format',
  'mkfs',
  'dd',
  ' shred',
  '>',
]);

const SAFE_READ_COMMANDS = new Set(['ls', 'dir', 'pwd', 'cat', 'type', 'get-content']);

const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show']);

const isWindows = process.platform === 'win32';

const expandEnvVars = (text: string): string => {
  return text
    .replace(/\$\{env:([^}]+)\}/gi, (_, key) => process.env[key] || '')
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key) => process.env[key] || '')
    .replace(/\$(HOME|PWD)(?=$|[\\/])/gi, (_, key) => {
      if (key === 'HOME') return os.homedir();
      return '';
    });
};

const expandHome = (text: string): string => {
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
};

const isDynamic = (text: string): boolean => {
  if (text.startsWith('(') || text.startsWith('@(')) return true;
  if (text.includes('$(') || text.includes('${') || text.includes('`')) {
    return true;
  }
  return text.includes('$');
};

const parseCommand = (command: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      }
      current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      current += char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
};

const detectFileOps = (command: string): { dirs: Set<string>; files: Set<string> } => {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const tokens = parseCommand(command);
  const cmd = tokens[0]?.toLowerCase();

  if (!cmd) return { dirs, files };

  if (FILE_OPS.has(cmd) || CWD_OPS.has(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('-')) continue;

      const expanded = expandHome(expandEnvVars(token));
      if (isDynamic(expanded)) continue;

      try {
        const resolved = path.resolve(expanded);
        if (resolved.includes('..') || resolved.startsWith('/') || /^[a-z]:/i.test(resolved)) {
          const stat = statSync(resolved);
          if (stat.isDirectory()) {
            dirs.add(resolved);
          } else {
            files.add(resolved);
          }
        }
      } catch {
        files.add(expanded);
      }
    }
  }

  return { dirs, files };
};

const isDangerous = (command: string): boolean => {
  const tokens = parseCommand(command);
  const cmd = tokens[0]?.toLowerCase();

  if (DANGEROUS_OPS.has(cmd || '')) return true;

  if ((cmd === 'rm' || cmd === 'del') && tokens.includes('-rf')) return true;

  const hasPipeToFile = />\s*[\/]/i.test(command);
  if (hasPipeToFile) return true;

  return false;
};

const hasShellControlOperators = (command: string): boolean => /(?:&&|\|\||[|;<>])/.test(command);

const isSafeReadOnlyCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed || hasShellControlOperators(trimmed)) {
    return false;
  }

  const tokens = parseCommand(trimmed);
  const cmd = tokens[0]?.toLowerCase();
  if (!cmd) {
    return false;
  }

  if (SAFE_READ_COMMANDS.has(cmd)) {
    return true;
  }

  if (cmd !== 'git') {
    return false;
  }

  const subcommand = tokens[1]?.toLowerCase();
  return Boolean(subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand));
};

const getShell = (): { shell: string; args: string[]; name: string } => {
  if (isWindows) {
    const ps = process.env.PSModulePath?.includes('PowerShell\\7');
    if (ps) {
      return {
        shell: 'pwsh',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
        name: 'powershell',
      };
    }
    return {
      shell: 'powershell',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'powershell',
    };
  }
  return { shell: '/bin/bash', args: ['-c'], name: 'bash' };
};

// Cache for command-existence checks to avoid repeated disk access
const commandExistsCache = new Map<string, boolean>();

/**
 * CRITICAL: Allowed base commands for interpret mode output.
 * Only commands in this set may be generated by interpret mode.
 */
const ALLOWED_INTERPRET_COMMANDS = new Set([
  'ls',
  'dir',
  'pwd',
  'cat',
  'type',
  'get-content',
  'get-childitem',
  'git',
  'bun',
  'npm',
  'node',
  'mkdir',
  'touch',
  'new-item',
  'rm',
  'del',
  'remove-item',
  'grep',
  'select-string',
  'find',
  'get-location',
]);

/**
 * Strip quoted strings from a command to enable accurate metacharacter detection.
 * Returns the command with quoted content replaced by placeholders.
 */
function stripQuotedText(command: string): string {
  return command
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, '``');
}

/**
 * CRITICAL: Check for unquoted shell metacharacters that enable command injection.
 * Rejects: ; | & ` $ ( ) { } < > ! # [ ] * ~
 * Returns true if dangerous metacharacters are found outside quoted strings.
 */
function hasShellMetacharacters(command: string): boolean {
  const stripped = stripQuotedText(command);
  // Metacharacters that enable injection or unexpected behavior
  return /[;|&`$(){}<>!#\[\]*~]/.test(stripped);
}

/**
 * CRITICAL: Check if a command exists on disk by walking PATH.
 * Replaces unsafe `which` shell command with fs.access() calls.
 * Caches results per session to avoid repeated checks.
 */
function commandExists(command: string): boolean {
  // If it's an absolute path, check directly
  if (path.isAbsolute(command)) {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // If it contains a path separator, treat as relative path
  if (command.includes('/') || (isWindows && command.includes('\\'))) {
    try {
      accessSync(path.resolve(command), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Check cache first
  const cached = commandExistsCache.get(command);
  if (cached !== undefined) return cached;

  // Walk PATH to find the command
  const pathEnv = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathEnv) {
    if (!dir) continue;
    const fullPath = path.join(dir, command);
    // On Windows, try with common extensions
    if (isWindows) {
      for (const ext of ['.exe', '.cmd', '.bat', '.ps1', '']) {
        try {
          accessSync(fullPath + ext, fsConstants.X_OK);
          commandExistsCache.set(command, true);
          return true;
        } catch {
          // continue
        }
      }
    } else {
      try {
        accessSync(fullPath, fsConstants.X_OK);
        commandExistsCache.set(command, true);
        return true;
      } catch {
        // continue
      }
    }
  }

  commandExistsCache.set(command, false);
  return false;
}

/**
 * Execute shell commands - the most powerful and dangerous tool
 */
export class ShellTool extends BaseTool {
  name = 'shell';
  description =
    'Execute a shell command or convert natural language to shell commands. Use this for actual repo or system state checks like git status, npm build, tests, pwd, ls, or other terminal inspection commands. Prefer read, write, and edit for file work instead of shell commands. WARNING: interpret=true executes AI-generated commands which may be unsafe; always review before approval.';
  isDestructive = true;
  requiresApproval = true;
  mutatesFiles = true;
  mutatesExternalState = true;
  searchHint = 'execute run command terminal process git npm build test';
  kind = ToolKind.Execute;

  inputSchema = {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description:
          'The shell command to execute or natural language description of what you want to do',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000 = 2 minutes)',
      },
      interpret: {
        type: 'boolean',
        description: 'Whether to interpret natural language into shell commands (default: false)',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables to set',
      },
    },
    required: ['command'],
  };

  private readonly MODEL_MAX_LINES = 40;
  private readonly MODEL_MAX_CHARS = 4000;
  private readonly PREVIEW_MAX_LINES = 20;
  private readonly PREVIEW_MAX_CHARS = 2000;

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    let command = input.command as string;
    const interpret = (input.interpret as boolean) || false;
    const cwd = (input.cwd as string) || context.workingDirectory;
    const timeout = (input.timeout as number) || 120000;
    const extraEnv = (input.env as Record<string, string>) || {};

    let finalCommand = command;
    const expanded = expandEnvVars(finalCommand);
    if (expanded !== finalCommand) {
      finalCommand = expanded;
    }

    const originalCommand = finalCommand;

    if (isWindows && command.includes('&&')) {
      command = command.replace(/&&/g, ';');
    }

    if (interpret) {
      const interpretedCommand = this.interpretCommand(command, context);
      if (interpretedCommand !== command) {
        command = interpretedCommand;
      }

      // CRITICAL: Validate interpreted commands before execution
      // 1. Reject unquoted shell metacharacters (injection prevention)
      if (hasShellMetacharacters(command)) {
        return this.error(
          'BLOCKED: Interpreted command contains shell metacharacters that may enable command injection. ' +
            'Command rejected for security reasons.',
        );
      }

      // 2. Check base command is in the allowlist
      const tokens = parseCommand(command);
      const baseCmd = tokens[0]?.toLowerCase();
      if (baseCmd && !ALLOWED_INTERPRET_COMMANDS.has(baseCmd)) {
        return this.error(
          `BLOCKED: Command '${baseCmd}' is not in the allowed interpret mode list. ` +
            `Allowed commands: ${[...ALLOWED_INTERPRET_COMMANDS].sort().join(', ')}.`,
        );
      }

      // 3. Verify the base command exists on disk via PATH traversal
      //    (replaces unsafe `which` shell command with fs.access()).
      //    Skip for known shell builtins (cat, ls, pwd, type, etc.) that
      //    are handled by the shell itself and may not be standalone executables.
      if (
        baseCmd &&
        !ALLOWED_INTERPRET_COMMANDS.has(baseCmd) &&
        !commandExists(baseCmd)
      ) {
        return this.error(
          `BLOCKED: Command '${baseCmd}' not found on the system PATH.`,
        );
      }
    }

    let workingDir: string;
    try {
      workingDir = PathSecurity.resolveWithinWorkspace(cwd, context.workingDirectory);
    } catch (err) {
      return this.error(`Invalid working directory: ${getErrorMessage(err)}`);
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const { shell, args, name } = getShell();
      const shellArgs = [...args, command];

      const proc = spawn(shell, shellArgs, {
        cwd: workingDir,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 30000) {
          stdout = stdout.substring(0, 30000) + '\n... (output truncated)';
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10000) {
          stderr = stderr.substring(0, 10000) + '\n... (stderr truncated)';
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        if (killed) {
          resolve(this.error(`Command timed out after ${timeout}ms`));
          return;
        }

        const commandDisplay =
          interpret && originalCommand !== command
            ? `Original: ${originalCommand}\nExecuted: ${command}`
            : `$ ${command}`;

        const stdoutSummary = this.formatStream(stdout, this.MODEL_MAX_LINES, this.MODEL_MAX_CHARS);
        const stderrSummary = this.formatStream(stderr, this.MODEL_MAX_LINES, this.MODEL_MAX_CHARS);
        const stdoutPreview = this.formatStream(
          stdout,
          this.PREVIEW_MAX_LINES,
          this.PREVIEW_MAX_CHARS
        );
        const stderrPreview = this.formatStream(
          stderr,
          this.PREVIEW_MAX_LINES,
          this.PREVIEW_MAX_CHARS
        );

        const output = this.buildSummaryOutput(
          commandDisplay,
          code,
          stdoutSummary.text,
          stderrSummary.text,
          stdoutSummary.truncated || stderrSummary.truncated
        );

        const artifacts = {
          kind: 'shell_output',
          command: commandDisplay,
          exitCode: code,
          shell: name,
          stdout: stdoutPreview.text,
          stderr: stderrPreview.text,
          truncated:
            stdoutSummary.truncated ||
            stderrSummary.truncated ||
            stdoutPreview.truncated ||
            stderrPreview.truncated,
        };

        if (code === 0) {
          resolve({
            success: true,
            output,
            modelOutput: output,
            summary: `Shell command completed with exit code ${code}.`,
            artifacts,
          });
        } else {
          resolve({
            success: false,
            output,
            modelOutput: output,
            summary: `Shell command failed with exit code ${code}.`,
            artifacts,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve(this.error(`Failed to execute command: ${err.message}`));
      });
    });
  }

  override async shouldConfirmExecute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<string | null> {
    const command = String(input.command || '');
    if (!command.trim()) {
      return 'Shell commands require explicit confirmation.';
    }

    const interpret = (input.interpret as boolean) || false;
    if (interpret) {
      return 'AI-generated shell commands require explicit confirmation (interpret=true).';
    }

    if (isDangerous(command)) {
      return 'Dangerous command detected - may cause data loss.';
    }

    if (isSafeReadOnlyCommand(command)) {
      return null;
    }

    return 'Shell command may mutate files or external state.';
  }

  private formatStream(
    text: string,
    maxLines: number,
    maxChars: number
  ): { text: string; truncated: boolean } {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return { text: '', truncated: false };
    }

    const lines = normalized.split('\n');
    const limitedLines = lines.slice(0, maxLines);
    let truncated = lines.length > maxLines;

    let joined = limitedLines.join('\n');
    if (joined.length > maxChars) {
      joined = joined.slice(0, maxChars).trimEnd();
      truncated = true;
    }

    if (truncated) {
      joined += '\n... output truncated; rerun with a narrower command if needed';
    }

    return { text: joined, truncated };
  }

  private buildSummaryOutput(
    commandDisplay: string,
    exitCode: number | null,
    stdout: string,
    stderr: string,
    truncated: boolean
  ): string {
    const parts = [
      commandDisplay,
      `Exit code: ${exitCode}`,
      stdout ? `\nSTDOUT:\n${stdout}` : '',
      stderr ? `\nSTDERR:\n${stderr}` : '',
      truncated ? '\nNote: Command output was truncated for context efficiency.' : '',
    ];

    return parts.filter(Boolean).join('\n');
  }

  private interpretCommand(input: string, _context: ToolExecutionContext): string {
    const trimmed = input.trim().toLowerCase();

    const sanitizeShellChars = (cmd: string): string => {
      return cmd
        .replace(/\$[^$]*\$/g, '')
        .replace(/`[^`]*`/g, '')
        .replace(/;[^\n]*/g, '')
        .replace(/\|[^\n]*/g, '')
        .replace(/&&/g, '')
        .replace(/\|\|/g, '')
        .trim();
    };

    /**
     * CRITICAL: Strict allowlist for interpret mode.
     * Only allows specific known-safe command patterns.
     * Blocks: curl, wget, nc, netcat, socat, eval, exec, docker, kubectl,
     *         ssh, scp, rsync, any command with $() or backticks.
     */
    const INTERPRET_BLOCKED = [
      /\bcurl\b/i,
      /\bwget\b/i,
      /\bnc\b/i,
      /\bnetcat\b/i,
      /\bsocat\b/i,
      /\beval\b/i,
      /\bexec\b/i,
      /\bdocker\b/i,
      /\bkubectl\b/i,
      /\bssh\b/i,
      /\bscp\b/i,
      /\brsync\b/i,
      /\bbash\b/i,
      /\bsh\b/i,
      /\bzsh\b/i,
      /\bpowershell\b/i,
      /\bpwsh\b/i,
      /\bchmod\b/i,
      /\bchown\b/i,
      /\bsudo\b/i,
      /\bsu\b/i,
      /\bkill\b/i,
      /\bpkill\b/i,
      /\bsystemctl\b/i,
      /\btee\b/i,
      /\bxargs\b/i,
    ];

    const BLOCKED_PATTERNS = [
      /\$\(/,
      /`[^`]+`/,
      /\|\|/,
      /&&/,
      /;/,
      />/,
      /</,
      /\bnohup\b/,
      /\bbackground\b/,
    ];

    // Block dangerous commands and patterns
    for (const pattern of INTERPRET_BLOCKED) {
      if (pattern.test(trimmed)) {
        return `echo "BLOCKED: Command '${trimmed.split(/\s+/)[0]}' is not allowed in interpret mode for security reasons."`;
      }
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(input)) {
        return `echo "BLOCKED: Shell injection pattern detected in interpret mode. Command rejected."`;
      }
    }

    if (
      trimmed.includes('show') ||
      trimmed.includes('display') ||
      trimmed.includes('view') ||
      trimmed.includes('cat')
    ) {
      if (trimmed.includes('file') || trimmed.includes('content')) {
        const fileMatch = input.match(/["']([^"']+)["']/);
        if (fileMatch) return sanitizeShellChars(`cat "${fileMatch[1]}"`);
        if (trimmed.includes('package.json')) return 'cat package.json';
        if (trimmed.includes('readme')) return 'cat README.md';
      }
    }

    if (trimmed.includes('list') || trimmed.includes('show') || trimmed.includes('ls')) {
      if (trimmed.includes('file') || trimmed.includes('directory')) {
        return isWindows ? 'Get-ChildItem' : 'ls -la';
      }
    }

    if (trimmed.includes('git')) {
      if (trimmed.includes('status')) return 'git status';
      if (trimmed.includes('log') || trimmed.includes('history')) return 'git log --oneline -10';
      if (trimmed.includes('diff') || trimmed.includes('changes')) return 'git diff';
      if (trimmed.includes('branch') || trimmed.includes('branches')) return 'git branch -a';
      if (trimmed.includes('add') && trimmed.includes('all')) return 'git add .';
      if (trimmed.includes('commit') && trimmed.includes('message')) {
        const messageMatch = input.match(/message[:\s]+["']?([^"']+)["']?/);
        if (messageMatch) return sanitizeShellChars(`git commit -m "${messageMatch[1]}"`);
      }
      if (trimmed.includes('push')) return 'git push';
      if (trimmed.includes('pull')) return 'git pull';
    }

    if (trimmed.includes('npm') || trimmed.includes('node')) {
      if (trimmed.includes('install') || trimmed.includes('add')) {
        const packageMatch = input.match(/install\s+(\w+)/);
        if (packageMatch) return sanitizeShellChars(`bun add ${packageMatch[1]}`);
        return 'bun install';
      }
      if (trimmed.includes('build')) return 'bun run build';
      if (trimmed.includes('test')) return 'bun test';
      if (trimmed.includes('start') || trimmed.includes('run')) return 'bun start';
      if (trimmed.includes('version')) return 'bun --version';
    }

    if (trimmed.includes('build') || trimmed.includes('compile')) {
      if (trimmed.includes('typescript') || trimmed.includes('ts')) return 'bun tsc';
      if (trimmed.includes('vite')) return 'bun run dev';
    }

    if (trimmed.includes('search') || trimmed.includes('find') || trimmed.includes('grep')) {
      const searchTermMatch = input.match(/["']([^"']+)["']/);
      if (searchTermMatch) {
        return sanitizeShellChars(
          isWindows
            ? `Select-String -Path "*.*" -Pattern "${searchTermMatch[1]}"`
            : `grep -r "${searchTermMatch[1]}" .`
        );
      }
    }

    if (trimmed.includes('where') || trimmed.includes('current') || trimmed.includes('directory')) {
      return isWindows ? 'Get-Location' : 'pwd';
    }

    if (trimmed.includes('create') || trimmed.includes('make') || trimmed.includes('new')) {
      if (trimmed.includes('directory') || trimmed.includes('folder')) {
        const dirMatch = input.match(/(?:directory|folder)\s+["']?([^"']+)["']?/);
        if (dirMatch)
          return sanitizeShellChars(
            isWindows
              ? `New-Item -ItemType Directory -Path "${dirMatch[1]}"`
              : `mkdir "${dirMatch[1]}"`
          );
      }
      if (trimmed.includes('file')) {
        const fileMatch = input.match(/file\s+["']?([^"']+)["']?/);
        if (fileMatch)
          return sanitizeShellChars(
            isWindows
              ? `New-Item -ItemType File -Path "${fileMatch[1]}"`
              : `touch "${fileMatch[1]}"`
          );
      }
    }

    if (trimmed.includes('clean') || trimmed.includes('clear')) {
      if (trimmed.includes('node')) return 'rm -rf node_modules';
      if (trimmed.includes('build') || trimmed.includes('dist')) return 'rm -rf dist';
    }

    return input;
  }
}
