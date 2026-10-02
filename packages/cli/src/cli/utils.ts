/**
 * CLI Utility Functions
 *
 * ANSI color helpers, argument parsing, formatting, and shared constants.
 */

// =============================================================================
// ANSI Color Helpers (no external dependencies)
// =============================================================================

export const ESC = '\x1b[';

export const red = (s: string): string => `${ESC}31m${s}${ESC}0m`;
export const green = (s: string): string => `${ESC}32m${s}${ESC}0m`;
export const yellow = (s: string): string => `${ESC}33m${s}${ESC}0m`;
export const cyan = (s: string): string => `${ESC}36m${s}${ESC}0m`;
export const bold = (s: string): string => `${ESC}1m${s}${ESC}22m`;
export const dim = (s: string): string => `${ESC}2m${s}${ESC}22m`;
export const white = (s: string): string => `${ESC}37m${s}${ESC}0m`;
export const magenta = (s: string): string => `${ESC}35m${s}${ESC}22m`;

// =============================================================================
// Argument Parsing
// =============================================================================

export interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node and script path
  const result: ParsedArgs = {
    command: null,
    positional: [],
    flags: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '-h') {
      result.flags['help'] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // Boolean flag if next is absent or another flag
      if (next === undefined || next.startsWith('--')) {
        result.flags[key] = true;
      } else {
        result.flags[key] = next;
        i++; // consume value
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

export function getFlagString(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: string,
): string {
  const val = flags[key];
  if (typeof val === 'string') return val;
  return defaultValue;
}

export function getFlagNumber(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const val = flags[key];
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    if (!isNaN(n)) return n;
  }
  return defaultValue;
}

// =============================================================================
// Formatting Helpers
// =============================================================================

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

export function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
}

export function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function componentStatus(ok: boolean): string {
  return ok ? green('[OK]') : red('[FAIL]');
}

export function printSeparator(): void {
  console.log(dim('='.repeat(50)));
}

export function printHeader(title: string): void {
  console.log();
  console.log(bold(cyan(title)));
  printSeparator();
}
