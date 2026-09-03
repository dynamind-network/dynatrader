/**
 * DynaTrader Tool Profiles
 *
 * Canonical tool profile system inspired by DeepSeek Harness's "everything is a plugin"
 * architecture, OpenClaw's memory-core plugin, and Hermes's tool router.
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
 */

// ---------------------------------------------------------------------------
// Tool Profile Types
// ---------------------------------------------------------------------------

/**
 * Core profiles — ship with the base agent, always registered.
 * Like DeepSeek Harness's dsh-base bundle.
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
 * Like DeepSeek Harness's plugin-contributed tools via ctx.tools.register().
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
 * All tool profiles. Core profiles are always available.
 * Plugin profiles require a plugin to register tools for them.
 * 'full' expands to all tools (for evals/testing).
 */
export type ToolProfile = CoreProfile | PluginProfile | 'full';

// ---------------------------------------------------------------------------
// Tools per Profile
// ---------------------------------------------------------------------------

const CORE_TOOLS: Record<CoreProfile, string[]> = {
  base: ['read', 'write', 'edit', 'glob', 'grep', 'web_fetch'],
  memory: ['memory_search', 'memory_write'],
  multi_agent: ['spawn_subagent', 'sessions_list', 'sessions_history', 'session_search', 'session_status'],
  messaging: ['telegram_send', 'inbox_deliver'],
  media: ['voice_transcribe', 'tts', 'vision_analyze'],
  browser: ['browser'],
};

const PLUGIN_TOOLS: Record<PluginProfile, string[]> = {
  trading: ['market_data', 'exec'],
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
 * This is how sub-agents get scoped tool sets — like DeepSeek Harness's
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
export function getToolsForProfiles(profiles: ToolProfile[]): string[] {
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
    }
  }
  return [...tools];
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
 * Like DeepSeek Harness's Cordis pattern: plugins contribute services
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
