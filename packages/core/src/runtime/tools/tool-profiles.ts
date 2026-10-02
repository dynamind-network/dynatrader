import type { ToolRegistry } from '@dyna/contracts';

/**
 * DynaTrader Tool Profiles
 *
 * Canonical tool profile system
 * architecture and tool routing.
 *
 * Architecture (two-tier):
 * - CORE profiles ship with the base agent (like dsh-base bundle):
 *   base, memory, multi_agent, messaging, media, browser
 * - PLUGIN profiles are provided by workspace plugins:
 *   trading, risk
 *
 * Agent YAML definitions declare which profiles they need:
 *   profiles: [base, memory, trading]
 *
 * Sub-agents get scoped tool sets based on their profiles.
 * Core profiles are always included regardless of agent declaration.
 *
 * Financial capabilities (market data, indicators, scans, sizing, backtests)
 * are intentionally absent from every list here. They are reached through the
 * Node/Python REPL via the `sdk` stub -- see FIRST_PARTY_SDK_TOOL_CATALOG --
 * so the model composes them as code instead of calling them as fixed tools.
 * The `trading` profile therefore grants no direct tools; it exists only as
 * the default declaration profile for plugin capability contributions.
 */

// ---------------------------------------------------------------------------
// Tool Profile Types
// ---------------------------------------------------------------------------

/**
 * Core profiles — ship with the base agent, always registered.
 */
export const CORE_PROFILES = {
  BASE: 'base' as const,
  MEMORY: 'memory' as const,
  MULTI_AGENT: 'multi_agent' as const,
  MESSAGING: 'messaging' as const,
  MEDIA: 'media' as const,
  BROWSER: 'browser' as const,
};

/**
 * Plugin profiles — provided by workspace plugins, only available when loaded.
 * Plugins contribute tools via ctx.tools.register().
 */
export const PLUGIN_PROFILES = {
  TRADING: 'trading' as const,
  RISK: 'risk' as const,
};

/**
 * Core profiles — ship with the base agent, always registered.
 */
export type CoreProfile = typeof CORE_PROFILES[keyof typeof CORE_PROFILES];

/**
 * Plugin profiles — provided by workspace plugins, only available when loaded.
 */
export type PluginProfile = typeof PLUGIN_PROFILES[keyof typeof PLUGIN_PROFILES];
/**
 * Dynamically attributed tools, keyed by the profile that grants them.
 *
 * Keyed by any ToolProfile, not just plugin ones: tools contributed by
 * user-configured MCP servers are attributed to `base` so that connecting a
 * server makes its tools visible without bypassing the profile gate.
 */
export type PluginToolsByProfile = Partial<Record<ToolProfile, string[]>>;

/**
 * All tool profiles. Core profiles are always available.
 * Plugin profiles require a plugin to register tools for them.
 * 'full' expands to all tools (for evals/testing).
 */
export type ToolProfile = CoreProfile | PluginProfile | 'full';

// ---------------------------------------------------------------------------
// Tools per Profile
// ---------------------------------------------------------------------------

const CORE_TOOLS: Record<CoreProfile, string[]> = {
  base: ['read', 'write', 'edit', 'glob', 'grep', 'exec', 'task_output', 'task_list', 'task_stop', 'web_fetch', 'web_search', 'skills_list', 'skill_view', 'skill_manage', 'get_tool_result', 'todo', 'node_repl', 'python_repl'],
  memory: ['memory_search', 'memory_write'],
  multi_agent: ['delegate_task', 'agent_task_list', 'agent_task_status', 'agent_task_cancel', 'sessions_list', 'sessions_history', 'session_search', 'session_status'],
  messaging: ['telegram_send', 'inbox_deliver'],
  media: ['voice_transcribe', 'tts', 'vision_analyze'],
  browser: ['browser'],
};

const PLUGIN_TOOLS: Record<PluginProfile, string[]> = {
  // No direct tools. Financial capabilities are SDK-only: the model reaches
  // market_data/indicators/scan_market/size_position/backtest by writing code
  // in node_repl or python_repl and calling the injected `sdk` stub, so they
  // can be composed and chained rather than invoked one fixed tool call at a
  // time. The profile stays declared because plugin capability declarations
  // default to it.
  trading: [],
  risk: ['halt_trading', 'resume_trading', 'trading_halt_status', 'check_circuit_breakers'],
};

/**
 * 'full' expands to all tools (for evals/testing).
 */
const FULL_TOOLS: string[] = [
  ...Object.values(CORE_TOOLS).flat(),
  ...Object.values(PLUGIN_TOOLS).flat(),
];

/**
 * Tool names available in each profile.
 * These must match the tool names registered in the ToolRegistry.
 */
const TOOLS_BY_PROFILE: Record<ToolProfile, string[]> = {
  ...CORE_TOOLS,
  ...PLUGIN_TOOLS,
  full: FULL_TOOLS,
};

// ---------------------------------------------------------------------------
// Profile Classification
// ---------------------------------------------------------------------------

const CORE_PROFILES_SET = new Set<ToolProfile>([
  'base', 'memory', 'multi_agent', 'messaging', 'media', 'browser',
]);

const PLUGIN_PROFILES_SET = new Set<ToolProfile>([
  'trading', 'risk',
]);

/**
 * Checks if a profile is a core profile (always registered).
 */
export function isCoreProfile(profile: ToolProfile): boolean {
  return CORE_PROFILES_SET.has(profile);
}

/**
 * Checks if a profile is a plugin profile (requires plugin registration).
 */
export function isPluginProfile(profile: ToolProfile): boolean {
  return PLUGIN_PROFILES_SET.has(profile);
}

// ---------------------------------------------------------------------------
// Profile Resolution — Main Agent
// ---------------------------------------------------------------------------

/**
 * Resolves the final set of tool profiles for the main agent.
 *
 * Core profiles (base, memory, multi_agent, messaging, media, browser)
 * are always included. Plugin profiles are included only if they are
 * in the activeProfiles list AND a plugin has registered tools for them.
 *
 * @param activeProfiles - User-requested profiles (e.g., ['trading'])
 * @param availablePluginProfiles - Profiles that plugins have registered tools for
 * @returns Resolved profiles with core always included
 */
export function resolveProfiles(
  activeProfiles?: ToolProfile[],
  availablePluginProfiles?: ToolProfile[],
): ToolProfile[] {
  const profiles = new Set<ToolProfile>(CORE_PROFILES_SET);

  if (activeProfiles) {
    const available = new Set(availablePluginProfiles ?? []);
    for (const profile of activeProfiles) {
      if (profile === 'full') {
        return Object.keys(TOOLS_BY_PROFILE) as ToolProfile[];
      }
      if (isCoreProfile(profile)) {
        profiles.add(profile);
      } else {
        // Plugin profile: only include if a plugin has registered tools for it
        if (available.has(profile)) {
          profiles.add(profile);
        }
      }
    }
  }

  return [...profiles];
}

// ---------------------------------------------------------------------------
// Profile Resolution — Sub-Agents (from YAML definitions)
// ---------------------------------------------------------------------------

/**
 * Resolves tool profiles for a sub-agent based on its YAML declaration.
 *
 * Agent YAML declares: profiles: [base, memory, trading]
 * Core profiles are always included. Plugin profiles are included only
 * if available from loaded plugins.
 *
 * This is how sub-agents get scoped tool sets —
 * toolFilter on SubagentStartRequest.
 *
 * @param agentProfiles - Profiles declared in agent YAML (e.g., ['base', 'trading'])
 * @param availablePluginProfiles - Profiles that plugins have registered tools for
 * @returns Resolved profiles with core always included
 */
export function resolveAgentProfiles(
  agentProfiles?: ToolProfile[],
  availablePluginProfiles?: ToolProfile[],
): ToolProfile[] {
  if (!agentProfiles || agentProfiles.length === 0) {
    // No profiles declared — default to core profiles only
    return [...CORE_PROFILES_SET];
  }

  const profiles = new Set<ToolProfile>(CORE_PROFILES_SET);
  const available = new Set(availablePluginProfiles ?? []);

  for (const profile of agentProfiles) {
    if (profile === 'full') {
      return Object.keys(TOOLS_BY_PROFILE) as ToolProfile[];
    }
    if (isCoreProfile(profile)) {
      profiles.add(profile);
    } else {
      // Plugin profile: only include if available
      if (available.has(profile)) {
        profiles.add(profile);
      }
    }
  }

  return [...profiles];
}

// ---------------------------------------------------------------------------
// Tool Set Resolution
// ---------------------------------------------------------------------------

/**
 * Gets all tool names for a set of profiles.
 * Profiles are additive — tools from all profiles are merged.
 * 'full' expands to all tools.
 */
export function getToolsForProfiles(profiles: ToolProfile[], pluginToolsByProfile?: PluginToolsByProfile): string[] {
  const tools = new Set<string>();
  for (const profile of profiles) {
    if (profile === 'full') {
      for (const tool of FULL_TOOLS) {
        tools.add(tool);
      }
    } else {
      for (const tool of TOOLS_BY_PROFILE[profile]) {
        tools.add(tool);
      }
      for (const tool of pluginToolsByProfile?.[profile] ?? []) {
        tools.add(tool);
      }
    }
  }
  return [...tools];
}

/** Return only profile-authorized tools that are actually registered. */
export function getRegisteredToolsForProfiles(
  registry: Pick<ToolRegistry, 'list'>,
  profiles: ToolProfile[],
  pluginToolsByProfile?: PluginToolsByProfile,
): string[] {
  const allowed = new Set(getToolsForProfiles(profiles, pluginToolsByProfile));
  return registry.list().map((handler) => handler.definition.name).filter((name) => allowed.has(name));
}

/**
 * @deprecated Use getToolsForProfiles instead — 'full' is now part of ToolProfile.
 */
export const getToolsForProfilesWithFull = getToolsForProfiles;

/**
 * Checks if a tool call is allowed given the active profiles.
 */
export function isToolAllowed(toolName: string, profiles: ToolProfile[]): boolean {
  const allowed = getToolsForProfiles(profiles);
  return allowed.includes(toolName);
}

/**
 * Gets the tool names for a single profile.
 */
export function getProfileTools(profile: ToolProfile): string[] {
  return [...TOOLS_BY_PROFILE[profile]];
}

/**
 * Lists all available profiles and their tool counts.
 */
export function listProfiles(): Array<{ profile: ToolProfile; toolCount: number; tools: string[]; isCore: boolean }> {
  return (Object.keys(TOOLS_BY_PROFILE) as ToolProfile[]).map((profile) => ({
    profile,
    toolCount: TOOLS_BY_PROFILE[profile].length,
    tools: [...TOOLS_BY_PROFILE[profile]],
    isCore: isCoreProfile(profile),
  }));
}

// ---------------------------------------------------------------------------
// Plugin Tool Registration
// ---------------------------------------------------------------------------

/**
 * Declaration of a tool provided by a plugin.
 * Plugins use this to register their tools with the ToolRegistry.
 *
 * Plugins contribute services
 * (tools) to a shared context (ToolRegistry).
 */
export interface PluginToolDeclaration {
  /** Unique tool name (must not conflict with built-in tools) */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** Category for tool organization */
  category: string;
  /** JSON Schema for tool parameters */
  inputSchema: Record<string, unknown>;
  /** Permissions required to use this tool */
  permissionsRequired?: string[];
  /** Side effects this tool produces */
  sideEffects?: string[];
  /** Risk level of this tool */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Whether this tool can run in parallel */
  canRunInParallel?: boolean;
  /** Whether this tool is read-only (safe to cache) */
  readOnly?: boolean;
  /** Explicitly allow this plugin capability to be invoked through Node/Python REPLs. */
  sdkCallable?: boolean;
  /** Name of the exported handler function in the plugin module */
  handler: string;
  /** Tool profiles this tool belongs to */
  profiles?: ToolProfile[];
}

/**
 * Gets all tool names that plugins have declared, grouped by profile.
 * This is used by the ToolRegistry to know which tools plugins provide.
 */
export function getPluginToolProfiles(declarations: PluginToolDeclaration[]): Map<ToolProfile, string[]> {
  const result = new Map<ToolProfile, string[]>();

  for (const decl of declarations) {
    const profiles = decl.profiles ?? (['trading'] as ToolProfile[]);
    for (const profile of profiles) {
      const tools = result.get(profile) ?? [];
      tools.push(decl.name);
      result.set(profile, tools);
    }
  }

  return result;
}

/**
 * Return plugin profiles that have at least one successfully registered tool.
 * An empty profile is not evidence that a plugin capability exists (notably,
 * the trading profile uses host-routed SDK calls and intentionally has no
 * direct model tools).
 */
export function getRegisteredPluginProfiles(
  declarations: PluginToolDeclaration[],
  registeredToolNames: Iterable<string>,
  hostProvidedProfiles: Iterable<PluginProfile> = [],
): PluginProfile[] {
  const registered = new Set(registeredToolNames);
  const available = new Set<PluginProfile>(hostProvidedProfiles);
  for (const declaration of declarations) {
    if (!registered.has(declaration.name)) continue;
    for (const profile of declaration.profiles ?? ['trading']) {
      if (isPluginProfile(profile)) available.add(profile as PluginProfile);
    }
  }
  return [...available];
}

/** Registered plugin tools by declared profile, excluding failed/unloaded handlers. */
export function getRegisteredPluginToolsByProfile(
  declarations: PluginToolDeclaration[],
  registeredToolNames: Iterable<string>,
): PluginToolsByProfile {
  const registered = new Set(registeredToolNames);
  const result: PluginToolsByProfile = {};
  for (const declaration of declarations) {
    if (!registered.has(declaration.name)) continue;
    for (const profile of declaration.profiles ?? ['trading']) {
      if (!isPluginProfile(profile)) continue;
      const tools = result[profile as PluginProfile] ?? [];
      if (!tools.includes(declaration.name)) tools.push(declaration.name);
      result[profile as PluginProfile] = tools;
    }
  }
  return result;
}
