import { execSync } from 'child_process';
import * as path from 'path';

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
}

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\s+1\b/i,
];

export function isCommandSafe(command: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Blocked dangerous command: ${command}` };
    }
  }
  return { safe: true };
}

export function executeShell(
  command: string,
  cwd: string,
  timeoutMs: number = 30000
): ShellResult {
  const safety = isCommandSafe(command);
  if (!safety.safe) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: safety.reason || 'Command blocked for safety',
      command,
    };
  }

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, CI: 'true' },
    });
    return {
      exitCode: 0,
      stdout: output,
      stderr: '',
      command,
    };
  } catch (error: any) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? 'Command failed',
      command,
    };
  }
}

export function isShellPassthrough(text: string): boolean {
  return text.startsWith('!') && text.length > 1;
}

export function extractShellCommand(text: string): string {
  return text.substring(1).trim();
}
