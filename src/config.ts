/**
 * YAML Config Loader
 *
 * Loads and validates ~/.dynatrader/config.yaml. API keys are never stored
 * in config - they come from environment variables.
 *
 * Philosophy: ONE main agent. No hardcoded subagents.
 * Subagents are ephemeral - spawned via session_spawn or delegate task.
 * User can configure persistent subagents in profiles.yaml.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface DynaConfig {
  workspace: {
    name: string;
    description: string;
  };
  runtime: {
    mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
    strictMode: boolean;
  };
  exchange: {
    id: string;
    sandbox: boolean;
  };
  models: {
    provider: string;
    model?: string;
  };
  gateway: {
    telegram: {
      enabled?: boolean;
      token?: string;
      allowedChatIds?: Array<number | string>;
      defaultChatId?: string;
    };
    discord: {
      enabled?: boolean;
      token?: string;
      clientId?: string;
      defaultChannelId?: string;
    };
    agentChat: {
      url?: string;
    };
  };
  mcp: {
    servers: Array<{
      name: string;
      transport: 'stdio' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      envFilter?: string[];
      includeTools?: string[];
      excludeTools?: string[];
      enabled?: boolean;
    }>;
  };
  logging: {
    level: string;
    audit: boolean;
  };
  terminal?: {
    maxTurns?: number;
  };
  market?: {
    symbols?: string[];
  };
  /**
   * Declarative plugin composition rows (dsh-style patch layer).
   * Rows are applied after bundled defaults and workspace plugin discovery;
   * a row with the same id as an earlier row replaces it, and
   * `enabled: false` drops a row entirely.
   */
  plugins?: Array<{
    id: string;
    /** "bundled:<name>", a plugin directory containing plugin.json, or a JS/TS entry file. */
    entry: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }>;
  strategyEngines?: Record<string, string>;
  lastModel?: string;
}

// ---------------------------------------------------------------------------
// Profiles types
// ---------------------------------------------------------------------------

export interface DynaProfiles {
  main: {
    name: string;
    description: string;
    max_subagents?: number;
    max_spawn_depth?: number;
    type?: 'manager' | 'leaf';
    team?: string;
    reportsTo?: string;
    roles?: string[];
    heartbeat?: {
      every?: string;
    } | string;
    subagents?: {
      allowAgents?: string[];
      allowRoles?: string[];
    };
  };
  subagents?: Array<{
    name: string;
    description: string;
    parent?: string;
    reportsTo?: string;
    roles?: string[];
    allowAgents?: string[];
    allowRoles?: string[];
    type?: 'manager' | 'leaf';
    team?: string;
    heartbeat?: {
      every?: string;
    } | string;
    subagents?: {
      allowAgents?: string[];
      allowRoles?: string[];
    };
  }>;
}

// ---------------------------------------------------------------------------
// Zod schemas for YAML validation
// ---------------------------------------------------------------------------

const ZodConfigSchema = z.object({
  workspace: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
  }).partial().optional(),
  runtime: z.object({
    mode: z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live']).optional(),
    strictMode: z.boolean().optional(),
  }).partial().optional(),
  exchange: z.object({
    id: z.string().optional(),
    sandbox: z.boolean().optional(),
  }).partial().optional(),
  models: z.object({
    provider: z.union([
      z.enum(['openai', 'anthropic', 'openrouter', 'deepseek', 'google', 'ollama', 'lmstudio']),
      z.literal(''),
    ]).optional(),
    model: z.string().optional(),
  }).partial().optional(),
  gateway: z.object({
    telegram: z.object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      allowedChatIds: z.array(z.union([z.string(), z.number()])).optional(),
      defaultChatId: z.string().optional(),
    }).partial().optional(),
    discord: z.object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      clientId: z.string().optional(),
      defaultChannelId: z.string().optional(),
    }).partial().optional(),
    agentChat: z.object({
      url: z.string().optional(),
    }).partial().optional(),
  }).partial().optional(),
  mcp: z.object({
    servers: z.array(z.object({
      name: z.string(),
      transport: z.enum(['stdio', 'http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string()).optional(),
      envFilter: z.array(z.string()).optional(),
      includeTools: z.array(z.string()).optional(),
      excludeTools: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    }).partial()).optional(),
  }).partial().optional(),
  logging: z.object({
    level: z.string().optional(),
    audit: z.boolean().optional(),
  }).partial().optional(),
  terminal: z.object({
    maxTurns: z.number().int().positive().optional(),
  }).partial().optional(),
  market: z.object({
    symbols: z.array(z.string()).optional(),
  }).partial().optional(),
  plugins: z.array(z.object({
    id: z.string().min(1),
    entry: z.string().min(1),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })).optional(),
  strategyEngines: z.record(z.string()).optional(),
  lastModel: z.string().optional(),
}).passthrough();

const ZodProfilesSchema = z.object({
  main: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    max_subagents: z.number().int().nonnegative().optional(),
    max_spawn_depth: z.number().int().nonnegative().optional(),
    type: z.enum(['manager', 'leaf']).optional(),
    team: z.string().optional(),
    reportsTo: z.string().optional(),
    roles: z.array(z.string()).optional(),
    heartbeat: z.union([
      z.string(),
      z.object({ every: z.string().optional() }).partial(),
    ]).optional(),
    subagents: z.object({
      allowAgents: z.array(z.string()).optional(),
      allowRoles: z.array(z.string()).optional(),
    }).partial().optional(),
  }).partial().optional(),
  subagents: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    parent: z.string().optional(),
    reportsTo: z.string().optional(),
    roles: z.array(z.string()).optional(),
    allowAgents: z.array(z.string()).optional(),
    allowRoles: z.array(z.string()).optional(),
    type: z.enum(['manager', 'leaf']).optional(),
    team: z.string().optional(),
    heartbeat: z.union([
      z.string(),
      z.object({ every: z.string().optional() }).partial(),
    ]).optional(),
    subagents: z.object({
      allowAgents: z.array(z.string()).optional(),
      allowRoles: z.array(z.string()).optional(),
    }).partial().optional(),
  })).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export function defaultConfig(): DynaConfig {
  return {
    workspace: {
      name: '',
      description: '',
    },
    runtime: {
      mode: 'paper',
      strictMode: false,
    },
    exchange: {
      id: '',
      sandbox: true,
    },
    models: {
      provider: '',
      model: '',
    },
    gateway: {
      telegram: {},
      discord: {},
      agentChat: {},
    },
    mcp: {
      servers: [],
    },
    logging: {
      level: 'info',
      audit: true,
    },
    terminal: {
      maxTurns: 30,
    },
    market: {
      symbols: [],
    },
    strategyEngines: {},
    lastModel: '',
  };
}

export function defaultProfiles(): DynaProfiles {
  return {
    main: {
      name: '',
      description: '',
      type: 'manager',
      subagents: {
        allowAgents: [],
        allowRoles: [],
      },
    },
    subagents: [],
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load config.yaml from the given workspace path.
 * Falls back to defaults if the file doesn't exist or is invalid.
 */
export async function loadConfig(workspacePath: string): Promise<DynaConfig> {
  const configPath = join(workspacePath, 'config.yaml');
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    return mergeWithDefaults(parsed);
  } catch {
    return defaultConfig();
  }
}

/**
 * Save config.yaml to the given workspace path.
 */
export async function saveConfig(
  workspacePath: string,
  config: DynaConfig,
): Promise<void> {
  const configPath = join(workspacePath, 'config.yaml');
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  await writeFile(configPath, content, 'utf-8');
}

/**
 * Load profiles.yaml from the given workspace path.
 * Falls back to defaults if the file doesn't exist or is invalid.
 */
export async function loadProfiles(workspacePath: string): Promise<DynaProfiles> {
  const profilesPath = join(workspacePath, 'profiles.yaml');
  try {
    const content = await readFile(profilesPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    return mergeProfilesWithDefaults(parsed);
  } catch {
    return defaultProfiles();
  }
}

/**
 * Save profiles.yaml to the given workspace path.
 */
export async function saveProfiles(
  workspacePath: string,
  profiles: DynaProfiles,
): Promise<void> {
  const profilesPath = join(workspacePath, 'profiles.yaml');
  const content = yaml.dump(profiles, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  await writeFile(profilesPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mergeWithDefaults(raw: Record<string, unknown>): DynaConfig {
  const defaults = defaultConfig();

  // Validate parsed YAML against Zod schema; fall back to defaults on failure
  const result = ZodConfigSchema.safeParse(raw);
  if (!result.success) {
    console.warn('[config] YAML validation warnings:', result.error.format());
  }
  const validated = result.success ? result.data : {} as Record<string, unknown>;

  const workspace = (validated['workspace'] as Record<string, unknown>) ?? {};
  const runtime = (validated['runtime'] as Record<string, unknown>) ?? {};
  const exchange = (validated['exchange'] as Record<string, unknown>) ?? {};
  const models = (validated['models'] as Record<string, unknown>) ?? {};
  const gateway = (validated['gateway'] as Record<string, unknown>) ?? {};
  const gatewayTelegram = (gateway['telegram'] as Record<string, unknown>) ?? {};
  const gatewayDiscord = (gateway['discord'] as Record<string, unknown>) ?? {};
  const gatewayAgentChat = (gateway['agentChat'] as Record<string, unknown>) ?? {};
  const mcp = (validated['mcp'] as Record<string, unknown>) ?? {};
  const logging = (validated['logging'] as Record<string, unknown>) ?? {};

  return {
    workspace: {
      name: (workspace['name'] as string) ?? defaults.workspace.name,
      description: (workspace['description'] as string) ?? defaults.workspace.description,
    },
    runtime: {
      mode: validateMode((runtime['mode'] as string) ?? defaults.runtime.mode),
      strictMode: (runtime['strictMode'] as boolean) ?? defaults.runtime.strictMode,
    },
    exchange: {
      id: (exchange['id'] as string) ?? defaults.exchange.id,
      sandbox: (exchange['sandbox'] as boolean) ?? defaults.exchange.sandbox,
    },
    models: {
      provider: validateProvider((models['provider'] as string) ?? defaults.models.provider),
      model: (models['model'] as string) ?? defaults.models.model,
    },
    gateway: {
      telegram: {
        enabled: (gatewayTelegram['enabled'] as boolean) ?? defaults.gateway.telegram.enabled,
        token: (gatewayTelegram['token'] as string) ?? defaults.gateway.telegram.token,
        allowedChatIds: Array.isArray(gatewayTelegram['allowedChatIds'])
          ? (gatewayTelegram['allowedChatIds'] as Array<string | number>)
          : defaults.gateway.telegram.allowedChatIds,
        defaultChatId: (gatewayTelegram['defaultChatId'] as string) ?? defaults.gateway.telegram.defaultChatId,
      },
      discord: {
        enabled: (gatewayDiscord['enabled'] as boolean) ?? defaults.gateway.discord.enabled,
        token: (gatewayDiscord['token'] as string) ?? defaults.gateway.discord.token,
        clientId: (gatewayDiscord['clientId'] as string) ?? defaults.gateway.discord.clientId,
        defaultChannelId: (gatewayDiscord['defaultChannelId'] as string) ?? defaults.gateway.discord.defaultChannelId,
      },
      agentChat: {
        url: (gatewayAgentChat['url'] as string) ?? defaults.gateway.agentChat.url,
      },
    },
    mcp: {
      servers: Array.isArray(mcp['servers'])
        ? (mcp['servers'] as Array<Record<string, unknown>>).map((server) => ({
            name: String(server['name'] ?? ''),
            transport: server['transport'] === 'http' ? 'http' : 'stdio',
            command: typeof server['command'] === 'string' ? server['command'] : undefined,
            args: Array.isArray(server['args']) ? (server['args'] as unknown[]).map(String) : undefined,
            url: typeof server['url'] === 'string' ? server['url'] : undefined,
            env: server['env'] && typeof server['env'] === 'object' ? (server['env'] as Record<string, string>) : undefined,
            envFilter: Array.isArray(server['envFilter']) ? (server['envFilter'] as unknown[]).map(String) : undefined,
            includeTools: Array.isArray(server['includeTools']) ? (server['includeTools'] as unknown[]).map(String) : undefined,
            excludeTools: Array.isArray(server['excludeTools']) ? (server['excludeTools'] as unknown[]).map(String) : undefined,
            enabled: typeof server['enabled'] === 'boolean' ? server['enabled'] : undefined,
          }))
        : [],
    },
    logging: {
      level: (logging['level'] as string) ?? defaults.logging.level,
      audit: (logging['audit'] as boolean) ?? defaults.logging.audit,
    },
    terminal: {
      maxTurns: typeof (validated['terminal'] as Record<string, unknown>)?.['maxTurns'] === 'number'
        ? ((validated['terminal'] as Record<string, unknown>)['maxTurns'] as number)
        : defaults.terminal?.maxTurns,
    },
    market: {
      symbols: Array.isArray((validated['market'] as Record<string, unknown>)?.['symbols'])
        ? ((validated['market'] as Record<string, unknown>)['symbols'] as string[])
        : defaults.market?.symbols,
    },
    plugins: normalizePluginRows(validated['plugins']),
    strategyEngines: (validated['strategyEngines'] as Record<string, string>) ?? defaults.strategyEngines,
    lastModel: (validated['lastModel'] as string) ?? defaults.lastModel,
  };
}

/**
 * Sanitize plugin composition rows from validated config.
 * Shared by the home config loader and workspace config.yaml parsing.
 */
export function normalizePluginRows(
  value: unknown,
): DynaConfig['plugins'] {
  if (!Array.isArray(value)) return undefined;
  const rows = (value as Array<Record<string, unknown>>)
    .filter((row) =>
      typeof row?.id === 'string' && row.id.length > 0 &&
      typeof row?.entry === 'string' && row.entry.length > 0)
    .map((row) => ({
      id: String(row.id),
      entry: String(row.entry),
      config: row.config && typeof row.config === 'object'
        ? (row.config as Record<string, unknown>)
        : undefined,
      enabled: typeof row.enabled === 'boolean' ? row.enabled : undefined,
    }));
  return rows.length > 0 ? rows : undefined;
}

function mergeProfilesWithDefaults(raw: Record<string, unknown>): DynaProfiles {
  const defaults = defaultProfiles();

  // Validate parsed YAML against Zod schema; fall back to defaults on failure
  const result = ZodProfilesSchema.safeParse(raw);
  if (!result.success) {
    console.warn('[profiles] YAML validation warnings:', result.error.format());
  }
  const validated = result.success ? result.data : {} as Record<string, unknown>;

  const main = (validated['main'] as Record<string, unknown>) ?? {};
  const rawSubagents = Array.isArray(validated['subagents'])
    ? (validated['subagents'] as Array<Record<string, unknown>>)
    : [];

  return {
    main: {
      name: (main['name'] as string) ?? defaults.main.name,
      description: (main['description'] as string) ?? defaults.main.description,
      max_subagents: typeof main['max_subagents'] === 'number' ? (main['max_subagents'] as number) : undefined,
      max_spawn_depth: typeof main['max_spawn_depth'] === 'number' ? (main['max_spawn_depth'] as number) : undefined,
      type: main['type'] === 'manager' || main['type'] === 'leaf' ? (main['type'] as 'manager' | 'leaf') : defaults.main.type,
      team: (main['team'] as string) ?? undefined,
      reportsTo: (main['reportsTo'] as string) ?? undefined,
      roles: normalizeStringArray(main['roles']),
      heartbeat: typeof main['heartbeat'] === 'string'
        ? main['heartbeat']
        : (main['heartbeat'] && typeof main['heartbeat'] === 'object'
          ? (main['heartbeat'] as Record<string, unknown>)
          : undefined),
      subagents: {
        allowAgents: normalizeStringArray((main['subagents'] as Record<string, unknown>)?.['allowAgents']),
        allowRoles: normalizeStringArray((main['subagents'] as Record<string, unknown>)?.['allowRoles']),
      },
    },
    subagents: rawSubagents.map((sub) => ({
      name: (sub['name'] as string) ?? 'unnamed',
      description: (sub['description'] as string) ?? '',
      parent: (sub['parent'] as string) ?? (sub['reportsTo'] as string) ?? undefined,
      reportsTo: (sub['reportsTo'] as string) ?? undefined,
      roles: normalizeStringArray(sub['roles']),
      allowAgents: normalizeStringArray(sub['allowAgents']),
      allowRoles: normalizeStringArray(sub['allowRoles']),
      type: sub['type'] === 'manager' || sub['type'] === 'leaf' ? sub['type'] as 'manager' | 'leaf' : undefined,
      team: (sub['team'] as string) ?? undefined,
      heartbeat: typeof sub['heartbeat'] === 'string'
        ? sub['heartbeat']
        : (sub['heartbeat'] && typeof sub['heartbeat'] === 'object'
          ? (sub['heartbeat'] as Record<string, unknown>)
          : undefined),
      subagents: {
        allowAgents: normalizeStringArray((sub['subagents'] as Record<string, unknown>)?.['allowAgents']),
        allowRoles: normalizeStringArray((sub['subagents'] as Record<string, unknown>)?.['allowRoles']),
      },
    })),
  };
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateMode(value: string): DynaConfig['runtime']['mode'] {
  const valid: DynaConfig['runtime']['mode'][] = [
    'research', 'backtest', 'paper', 'shadow', 'micro_live', 'live',
  ];
  return valid.includes(value as DynaConfig['runtime']['mode'])
    ? (value as DynaConfig['runtime']['mode'])
    : 'paper';
}

function validateProvider(value: string): DynaConfig['models']['provider'] {
  const valid: DynaConfig['models']['provider'][] = [
    'openai', 'anthropic', 'openrouter', 'deepseek', 'google', 'ollama', 'lmstudio',
  ];
  return valid.includes(value as DynaConfig['models']['provider'])
    ? (value as DynaConfig['models']['provider'])
    : '';
}
