/**
 * Application-wide constants for consistent limit values
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export const DYNAMIND_DIR = '.dynamind';

export const PATHS = {
  DYNAMIND_DIR,
  AUTH_FILE: 'auth.json',
  SETTINGS_FILE: 'settings.json',
  MCP_CONFIG_FILE: 'mcp-config.json',
  SESSIONS_DIR: 'sessions',
} as const;

export const LIMITS = {
  CONVERSATION: {
    RECENT_GOALS: 3,
    ACTIVE_SYMBOLS: 6,
    FINDINGS: 8,
    CONCLUSIONS: 6,
    RECENT_MESSAGES: 10,
  },
  TOOL: {
    LOOP_HISTORY: 4,
    MAX_CALLS_PER_TURN: 128,
    RESULT_SIZE_LIMIT: 50_000,
  },
  CACHE: {
    SCHEMA_TTL_MS: 5 * 60 * 1000,
    SECTION_TTL_MS: 5 * 60 * 1000,
  },
  COMPACTION: {
    PRUNE_MINIMUM: 20_000,
    PRUNE_PROTECT: 40_000,
    AUTOCOMPACT_BUFFER: 13_000,
    WARNING_THRESHOLD: 20_000,
    ERROR_THRESHOLD: 20_000,
    MAX_CONSECUTIVE_FAILURES: 3,
  },
  MEMORY: {
    MAX_MESSAGES: 5000,
    EMBEDDING_BATCH_SIZE: 100,
  },
  TIMEOUT: {
    DEFAULT: 30_000,
    MCP_HEARTBEAT: 30_000,
    MCP_RESPONSE: 10_000,
    MCP_RECONNECT: 1000,
    WEBSOCKET_RECONNECT_BASE: 1000,
    WEBSOCKET_RECONNECT_MAX: 30_000,
    TOOL_EXECUTION: 60_000,
    CHART_REFRESH_MIN: 5000,
    CHART_REFRESH_MAX: 300_000,
  },
} as const;

export function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export function getDynamindPath(...segments: string[]): string {
  return path.join(getHomeDirectory(), DYNAMIND_DIR, ...segments);
}

export async function ensureDynamindDir(): Promise<string> {
  const dir = getDynamindPath();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type MergeOptions = {
  protectedKeys?: string[];
};

export function deepMerge<T>(target: T, source: unknown, options: MergeOptions = {}): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return (source as T) ?? target;
  }

  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  const protectedKeys = new Set<string>(options.protectedKeys || []);

  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (protectedKeys.has(key)) continue;

    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value, options);
      continue;
    }
    result[key] = value;
  }
  return result as T;
}

