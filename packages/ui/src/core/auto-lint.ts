import { execSync } from 'child_process';

export interface LintResult {
  success: boolean;
  file: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule?: string;
}

export interface AutoLintConfig {
  enabled: boolean;
  commands: string[];
  maxOutputBytes: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: AutoLintConfig = {
  enabled: false,
  commands: ['npm run lint', 'npm run typecheck'],
  maxOutputBytes: 65536,
  timeoutMs: 30000,
};

export function loadAutoLintConfig(cwd: string): AutoLintConfig {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(cwd, '.dynamind', 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw.autoLint };
    }
  } catch {
    // Config not found, use defaults
  }
  return DEFAULT_CONFIG;
}

export function runAutoLint(cwd: string, config?: AutoLintConfig): LintResult[] {
  const lintConfig = config ?? loadAutoLintConfig(cwd);
  if (!lintConfig.enabled || lintConfig.commands.length === 0) return [];

  const results: LintResult[] = [];

  for (const command of lintConfig.commands) {
    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: lintConfig.timeoutMs,
        windowsHide: true,
        maxBuffer: lintConfig.maxOutputBytes,
      });
      // Empty output = no errors
      if (!output.trim()) continue;
      results.push(
        ...parseLintOutput(output, command)
      );
    } catch (error: any) {
      const stderr = error.stderr ?? '';
      const stdout = error.stdout ?? '';
      const output = stdout + stderr;
      if (output.trim()) {
        results.push(...parseLintOutput(output, command));
      }
    }
  }

  return results;
}

function parseLintOutput(output: string, command: string): LintResult[] {
  const results: LintResult[] = [];
  const lines = output.split('\n').filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // TypeScript/ESLint format: file(line,col): error TS...: message
    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+|ES\d+)?\s*(.+)$/);
    if (tsMatch) {
      results.push({
        success: false,
        file: tsMatch[1],
        line: parseInt(tsMatch[2]),
        column: parseInt(tsMatch[3]),
        severity: tsMatch[4] as 'error' | 'warning' | 'info',
        rule: tsMatch[5],
        message: tsMatch[6],
      });
      continue;
    }

    // ESLint compact format: file:line:col: severity message (rule)
    const eslintMatch = line.match(/^(.+?):(\d+):(\d+):\s+(error|warning|info)\s+(.+?)\s+\((.+)\)$/);
    if (eslintMatch) {
      results.push({
        success: false,
        file: eslintMatch[1],
        line: parseInt(eslintMatch[2]),
        column: parseInt(eslintMatch[3]),
        severity: eslintMatch[4] as 'error' | 'warning' | 'info',
        message: eslintMatch[5],
        rule: eslintMatch[6],
      });
      continue;
    }

    // Generic error lines
    if (line.includes('error') || line.includes('Error')) {
      results.push({
        success: false,
        file: '',
        severity: 'error',
        message: line,
      });
    }
  }

  return results;
}

export function formatLintResults(results: LintResult[]): string {
  if (results.length === 0) return '';

  const errors = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warning');

  const header = `[Auto-lint] ${errors.length} error(s), ${warnings.length} warning(s)`;
  const details = results
    .slice(0, 20)
    .map((r) => {
      const loc = r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : '<unknown>';
      return `  ${r.severity === 'error' ? '✗' : '⚠'} ${loc} ${r.message}${r.rule ? ` (${r.rule})` : ''}`;
    })
    .join('\n');

  return `${header}\n${details}`;
}

