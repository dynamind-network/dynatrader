import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX-STYLE: Hardcoded banned interpreters (regardless of rules)
// These are NEVER allowed even in YOLO mode — they can execute arbitrary code
// ═══════════════════════════════════════════════════════════════════════════════
const BANNED_INTERPRETERS = new Set([
  'python', 'python3', 'python2',
  'ruby',
  'perl',
  'lua',
  'php',
  'node',       // node -e can execute arbitrary JS
  'deno',
  'bun',
  'tsc',        // TypeScript compiler can execute code
  'npx',        // npx can download and run arbitrary packages
  'pip',        // pip install can execute setup.py
  'gem',        // gem install can execute code
  'cargo',      // cargo run can execute code
  'go',         // go run can execute code
  'java',       // java -jar can execute code
  'javac',      // Java compiler
  'rustc',      // Rust compiler
  'gcc',        // C compiler
  'g++',        // C++ compiler
  'make',       // make can execute arbitrary commands
  'cmake',      // cmake can execute commands
  'docker',     // docker can escape containment
  'kubectl',    // kubectl can modify cluster
  'terraform',  // terraform can modify infrastructure
  'ansible',    // ansible can execute on remote hosts
]);

const READONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'echo',
  'pwd',
  'cd',
  'find',
  'grep',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'date',
  'whoami',
  'uname',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'which',
  'where',
  'env',
  'set',
  'git',
  'hg',
  'svn',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX-STYLE: Rule-based command approval DSL
// Deny rules ALWAYS take precedence over allow rules
// ═══════════════════════════════════════════════════════════════════════════════
interface CommandRule {
  pattern: RegExp;
  reason: string;
}

// Hardcoded deny rules — ALWAYS enforced regardless of approval mode
const HARD_DENIED_PATTERNS: CommandRule[] = [
  // Core destructive commands
  { pattern: /\brm\s+(-rf?|--recursive)\b/i, reason: 'Recursive delete' },
  { pattern: /\bdel\s+\/[fqs]\b/i, reason: 'Windows force delete' },
  { pattern: /\bformat\b/i, reason: 'Disk format' },
  { pattern: /\bmkfs\b/i, reason: 'Filesystem creation' },
  { pattern: /\bdd\s+of=/i, reason: 'Raw disk write' },
  { pattern: /\bchmod\s+[0-7]*7[0-7]*[0-7]*\b/, reason: 'World-writable permissions' },
  { pattern: /\bsudo\b/i, reason: 'Elevation' },
  { pattern: /\bshutdown\b/i, reason: 'System shutdown' },
  { pattern: /\breboot\b/i, reason: 'System reboot' },
  { pattern: /\bpowershell\s+.*-[eE]ncodedCommand\b/i, reason: 'Encoded PowerShell' },
  { pattern: /\bcurl.*\|\s*(bash|sh|zsh)\b/i, reason: 'Pipe to shell' },
  { pattern: /\bwget.*\|\s*(bash|sh|zsh)\b/i, reason: 'Pipe to shell' },

  // Obfuscation bypass detection
  { pattern: /\$[\({][^\)}]*\)/i, reason: 'Command substitution' },
  { pattern: /\bbase64\s+(-d|--decode)\b/i, reason: 'Base64 decode pipe' },
  { pattern: /\bxargs\b/i, reason: 'xargs execution' },
  { pattern: /\bexec\b/i, reason: 'exec replaces process' },
  { pattern: /\beval\b/i, reason: 'eval executes string' },

  // Command chaining to bypass single-command checks
  { pattern: /[;&|`]/, reason: 'Command chaining (semicolons, pipes, backticks)' },
  { pattern: /\btee\b/i, reason: 'tee can write files' },

  // Reverse shells and backdoors
  { pattern: /\bnc\s+.*-e\b/i, reason: 'Netcat reverse shell' },
  { pattern: /\bbash\s+-c\b/i, reason: 'bash -c execution' },
  { pattern: /\bsh\s+-c\b/i, reason: 'sh -c execution' },

  // File system escape attempts
  { pattern: /\.\.\/\.\.\//, reason: 'Path traversal' },
  { pattern: /\.\.\\\.\.\\/, reason: 'Windows path traversal' },
  { pattern: /\/etc\/(passwd|shadow|hosts)/i, reason: 'System file access' },

  // Network/data exfiltration
  { pattern: /\bnc\s+/i, reason: 'Netcat' },
  { pattern: /\bncat\s+/i, reason: 'Ncat' },
  { pattern: /\bsocat\s+/i, reason: 'Socat' },
  { pattern: /\bssh\s+/i, reason: 'SSH' },
  { pattern: /\bscp\s+/i, reason: 'SCP' },
  { pattern: /\brsync\s+/i, reason: 'Rsync' },
  { pattern: /\bftp\s+/i, reason: 'FTP' },
  { pattern: /\btelnet\s+/i, reason: 'Telnet' },

  // Process/memory manipulation
  { pattern: /\bkill\s+-9\b/i, reason: 'Force kill' },
  { pattern: /\bpkill\b/i, reason: 'Process kill' },
  { pattern: /\bkillall\b/i, reason: 'Kill all' },
  { pattern: /\btaskkill\b/i, reason: 'Windows task kill' },
  { pattern: /\breg\s+delete\b/i, reason: 'Windows registry delete' },
  { pattern: /\bregsvr32\b/i, reason: 'DLL registration (code exec)' },

  // CRITICAL: Shell redirect blocking (Cline-style)
  { pattern: />>?\s*[\/~]/, reason: 'Shell redirect to file' },
  { pattern: /<\s*[\/~]/, reason: 'Shell input redirect from file' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CLINE-STYLE: Environment variable isolation
// Only specific safe env vars are passed to child processes
// ═══════════════════════════════════════════════════════════════════════════════
const ALLOWED_ENV_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'CI',
  'DYNAMIND_WORKSPACE_DIR',
]);

function getIsolatedEnv(): Record<string, string> {
  const isolated: Record<string, string> = {};
  for (const key of ALLOWED_ENV_VARS) {
    const val = process.env[key];
    if (val !== undefined) {
      isolated[key] = val;
    }
  }
  return isolated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND APPROVAL DSL (Codex-style)
// ═══════════════════════════════════════════════════════════════════════════════
interface CommandApprovalResult {
  allowed: boolean;
  reason: string | null;
  rule: 'allowlist' | 'deny' | 'banned' | 'dangerous' | 'safe';
}

function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Handle paths: /usr/bin/git -> git, C:\tools\git.exe -> git
  const parts = trimmed.split(/[\s\\/]+/);
  const lastPart = parts[0] || '';
  // Remove extension on Windows
  return lastPart.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

function evaluateCommand(command: string): CommandApprovalResult {
  const trimmed = command.trim();

  // Block empty commands
  if (!trimmed || /^\s*$/.test(trimmed)) {
    return { allowed: false, reason: 'Empty command', rule: 'deny' };
  }

  // Block null bytes (injection vector)
  if (trimmed.includes('\0')) {
    return { allowed: false, reason: 'Null byte detected', rule: 'deny' };
  }

  // Block excessive length
  if (trimmed.length > 4096) {
    return { allowed: false, reason: 'Command exceeds 4096 chars', rule: 'deny' };
  }

  const baseCommand = extractBaseCommand(trimmed);

  // CODEX-STYLE: Hardcoded banned interpreters — ALWAYS blocked
  if (BANNED_INTERPRETERS.has(baseCommand)) {
    return {
      allowed: false,
      reason: `Interpreter '${baseCommand}' is permanently banned — can execute arbitrary code`,
      rule: 'banned',
    };
  }

  // DENY RULES TAKE PRECEDENCE (Cline-style)
  for (const rule of HARD_DENIED_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Denied: ${rule.reason}`,
        rule: 'deny',
      };
    }
  }

  // Allowlist check
  if (READONLY_COMMANDS.has(baseCommand)) {
    return { allowed: true, reason: null, rule: 'allowlist' };
  }

  // Not in allowlist and not explicitly denied
  return {
    allowed: false,
    reason: `Command '${baseCommand}' not in allowlist`,
    rule: 'allowlist',
  };
}

function isCommandSafe(command: string): boolean {
  const result = evaluateCommand(command);
  if (!result.allowed) {
    console.warn(`[shell-security] Blocked: ${result.reason} (rule: ${result.rule})`);
  }
  return result.allowed;
}

export interface ShellExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  command: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROK-STYLE: Dry-run mode for destructive operations
// ═══════════════════════════════════════════════════════════════════════════════
export interface ShellOptions {
  workingDir?: string;
  allowUnsafe?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  env?: Record<string, string>;
}

export async function executeShellCommand(
  command: string,
  options?: ShellOptions
): Promise<ShellExecutionResult> {
  const trimmed = command.trim();

  if (!trimmed) {
    return {
      success: false,
      output: '',
      error: 'Empty command',
      command: trimmed,
    };
  }

  // DRY-RUN MODE: Preview what would execute without actually running
  if (options?.dryRun) {
    const evaluation = evaluateCommand(trimmed);
    return {
      success: true,
      output: JSON.stringify({
        dryRun: true,
        command: trimmed,
        wouldExecute: evaluation.allowed,
        reason: evaluation.reason,
        rule: evaluation.rule,
      }, null, 2),
      command: trimmed,
    };
  }

  if (!options?.allowUnsafe && !isCommandSafe(trimmed)) {
    const evaluation = evaluateCommand(trimmed);
    return {
      success: false,
      output: '',
      error: `Command blocked: ${evaluation.reason}. Use --allow-unsafe to override.`,
      command: trimmed,
    };
  }

  // CLINE-STYLE: Environment variable isolation
  const execEnv = options?.env
    ? { ...getIsolatedEnv(), ...options.env }
    : getIsolatedEnv();

  try {
    const { stdout, stderr } = await execAsync(trimmed, {
      cwd: options?.workingDir,
      timeout: options?.timeoutMs ?? EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // CRITICAL: Use isolated environment to prevent env var leakage
      env: execEnv,
    });

    let output = stdout || stderr || '';
    if (output.length > MAX_OUTPUT_CHARS) {
      output =
        output.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters]`;
    }

    return {
      success: true,
      output,
      command: trimmed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: '',
      error: message,
      command: trimmed,
    };
  }
}

const SHELL_BLOCK_REGEX = /!`([^`]+)`/g;

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX-STYLE: Structured audit trail with OpenTelemetry-compatible fields
// ═══════════════════════════════════════════════════════════════════════════════
interface ShellAuditEntry {
  timestamp: string;
  traceId: string;        // Unique ID for correlating events
  command: string;
  baseCommand: string;
  success: boolean;
  blocked: boolean;
  blockReason?: string;
  blockRule?: string;
  durationMs: number;
  outputPreview: string;
  error?: string;
  workingDir?: string;
}

const SHELL_AUDIT_LOG: ShellAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 5000; // Increased from 1000

function generateTraceId(): string {
  return `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logShellExecution(
  command: string,
  success: boolean,
  blocked: boolean,
  blockReason?: string,
  blockRule?: string,
  output?: string,
  error?: string,
  workingDir?: string,
  durationMs = 0,
): void {
  const entry: ShellAuditEntry = {
    timestamp: new Date().toISOString(),
    traceId: generateTraceId(),
    command,
    baseCommand: extractBaseCommand(command),
    success,
    blocked,
    blockReason,
    blockRule,
    durationMs,
    outputPreview: (output || '').slice(0, 200),
    error,
    workingDir,
  };
  SHELL_AUDIT_LOG.push(entry);
  if (SHELL_AUDIT_LOG.length > MAX_AUDIT_ENTRIES) {
    SHELL_AUDIT_LOG.splice(0, SHELL_AUDIT_LOG.length - MAX_AUDIT_ENTRIES);
  }

  // CODEX-STYLE: Console audit for security-critical events
  if (blocked) {
    console.log(`[audit:BLOCKED] ${entry.timestamp} trace=${entry.traceId} cmd="${command}" reason="${blockReason}"`);
  } else if (!success) {
    console.log(`[audit:FAILED] ${entry.timestamp} trace=${entry.traceId} cmd="${command}" error="${error}"`);
  }
}

export function getShellAuditLog(): readonly ShellAuditEntry[] {
  return SHELL_AUDIT_LOG;
}

/**
 * Get audit log filtered by criteria
 */
export function queryAuditLog(filters: {
  blocked?: boolean;
  baseCommand?: string;
  since?: string;
  limit?: number;
}): ShellAuditEntry[] {
  let results = [...SHELL_AUDIT_LOG];
  if (filters.blocked !== undefined) results = results.filter(e => e.blocked === filters.blocked);
  if (filters.baseCommand) results = results.filter(e => e.baseCommand === filters.baseCommand);
  const since = filters.since;
  if (since) results = results.filter(e => e.timestamp >= since);
  if (filters.limit) results = results.slice(-filters.limit);
  return results;
}

export async function processShellBlocks(
  content: string,
  options?: {
    workingDir?: string;
    allowUnsafe?: boolean;
    dryRun?: boolean;
  }
): Promise<string> {
  const matches = [...content.matchAll(SHELL_BLOCK_REGEX)];

  if (matches.length === 0) {
    return content;
  }

  let result = content;

  for (const match of matches) {
    const fullMatch = match[0];
    const command = match[1];

    const startTime = Date.now();
    const evaluation = evaluateCommand(command);
    const durationMs = Date.now() - startTime;

    const execResult = await executeShellCommand(command, {
      workingDir: options?.workingDir,
      allowUnsafe: options?.allowUnsafe,
      dryRun: options?.dryRun,
    });

    logShellExecution(
      command,
      execResult.success,
      !evaluation.allowed,
      evaluation.reason || undefined,
      evaluation.rule,
      execResult.output,
      execResult.error,
      options?.workingDir,
      durationMs,
    );

    const replacement = execResult.success
      ? execResult.output.trim()
      : `[shell error: ${execResult.error}]`;

    result = result.replace(fullMatch, replacement);
  }

  return result;
}

export function extractShellCommands(content: string): string[] {
  const matches = [...content.matchAll(SHELL_BLOCK_REGEX)];
  return matches.map((m) => m[1]);
}

/**
 * Export command evaluation for external use
 */
export { evaluateCommand, BANNED_INTERPRETERS, HARD_DENIED_PATTERNS };

