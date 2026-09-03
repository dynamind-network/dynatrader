import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type {
  AgentManifest,
  RuntimeMode,
  RiskLevel,
  PermissionSet,
  ToolPermissions,
  SkillPermissions,
  MemoryPermissions,
  ArtifactType,
} from '@dyna/workspace';
import { loadWorkspaceIdentity, parseMarkdownFrontmatter } from '../workspace-identity';
import type { ToolProfile } from '../tools/tool-profiles';

// ---------------------------------------------------------------------------
// Extended AgentManifest with instruction body, filename, and directory fields
// ---------------------------------------------------------------------------

export interface ResolvedManifest extends AgentManifest {
  /** The Markdown instructions body (from SOUL.md) */
  instructions: string;
  /** The original .agent.md filename or directory name */
  filename: string;
  /** Semantic role tags used for discovery and routing */
  roles?: string[];
  /** Optional role selectors used to resolve subagents dynamically */
  subagentRoles?: string[];
  /** Agent type: manager or leaf */
  type: 'manager' | 'leaf';
  /** Team this agent belongs to */
  team: string;
  /** Parent agent this reports to */
  reportsTo: string;
  /** Sub-agents this agent can spawn */
  subagents: string[];
  /** Heartbeat interval (e.g. '1h', '30m') or 'on-demand' */
  heartbeat: string;
  /** Sandbox config if present */
  sandbox?: { mode: string; scope: string };
  /**
   * Tool profiles this agent needs (e.g., ['base', 'memory', 'trading']).
   * Core profiles (base, memory, multi_agent, messaging, media, browser)
   * are always included. Plugin profiles (trading, risk) require plugin registration.
   * Like DeepSeek Harness agent presets with toolFilter.
   */
  profiles?: ToolProfile[];
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`Agent not found: ${name}`);
    this.name = 'AgentNotFoundError';
  }
}

export class NoAgentsLoadedError extends Error {
  constructor() {
    super('No agents have been loaded into the registry');
    this.name = 'NoAgentsLoadedError';
  }
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

/**
 * Loads, caches, and provides lookup of agent manifests.
 *
 * Loading sources (in order):
 * 1. profiles.yaml main agent (always present)
 * 2. profiles.yaml persistent subagents (optional)
 * 3. agents/ directory with profile.yaml + SOUL.md (optional, legacy)
 * 4. Ephemeral subagents registered at runtime
 *
 * Loading is lazy and memoized — the workspace is scanned on the first
 * access (via `get`, `getAll`, `has`, etc.) and the result is cached for
 * the lifetime of the registry instance.
 */
export class AgentRegistry {
  /** Internal manifest cache keyed by agent name */
  private agents: Map<string, ResolvedManifest> = new Map();
  /** Absolute path to the workspace root */
  private workspacePath: string;
  /** Primary agent name loaded from IDENTITY.md / profiles.yaml */
  private primaryAgentName: string = '';
  /** `true` once the initial load has completed */
  private loaded: boolean = false;
  /** Deduplication guard so concurrent callers share a single load */
  private loadPromise: Promise<void> | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  // -----------------------------------------------------------------------
  // Public helpers
  // -----------------------------------------------------------------------

  /**
   * Force-load the registry now. Calling this is optional since all
   * lookup methods call `ensureLoaded` automatically.
   */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  /**
   * Look up a single agent by name.
   * @throws {AgentNotFoundError} if the agent does not exist
   */
  async get(name: string): Promise<ResolvedManifest> {
    await this.ensureLoaded();
    const entry = this.agents.get(name);
    if (!entry) {
      throw new AgentNotFoundError(name);
    }
    return entry;
  }

  /**
   * Look up a single agent by name, returning `undefined` instead of
   * throwing when the agent is not found.
   */
  async find(name: string): Promise<ResolvedManifest | undefined> {
    await this.ensureLoaded();
    return this.agents.get(name);
  }

  /**
   * Return the default agent (the main agent from profiles.yaml).
   */
  async getDefault(defaultAgentName?: string): Promise<ResolvedManifest> {
    await this.ensureLoaded();
    if (defaultAgentName && this.agents.has(defaultAgentName)) {
      return this.agents.get(defaultAgentName)!;
    }
    if (this.agents.size === 0) {
      throw new NoAgentsLoadedError();
    }
    return this.agents.values().next().value!;
  }

  /** Return a snapshot of every loaded agent. */
  async getAll(): Promise<ResolvedManifest[]> {
    await this.ensureLoaded();
    return Array.from(this.agents.values());
  }

  /** Check whether a particular agent name has been registered. */
  async has(name: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.agents.has(name);
  }

  /** Return the number of loaded agents. */
  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.agents.size;
  }

  // -----------------------------------------------------------------------
  // Ephemeral subagent support
  // -----------------------------------------------------------------------

  /**
   * Register an ephemeral subagent at runtime.
   * Ephemeral subagents are spawned via session_spawn or delegate task.
   * They have a short lifespan and minimal permissions.
   */
  registerEphemeral(name: string, instructions: string, options?: {
    description?: string;
    maxSpawnDepth?: number;
  }): ResolvedManifest {
    const reportsTo = this.getPrimaryAgentName();
    const manifest: ResolvedManifest = {
      name,
      version: '1.0.0',
      description: options?.description ?? `Ephemeral agent: ${name}`,
      allowedModes: ['research', 'paper'],
      riskLevel: 'low',
      permissions: { allow: ['read_memory', 'write_memory'], deny: [] },
      tools: { allow: [], deny: [] },
      skills: { allow: [], deny: [] },
      memory: { read: [], write: [] },
      outputs: ['Observation', 'Hypothesis'],
      approvalRequiredFor: [],
      instructions,
      filename: `ephemeral-${name}`,
      type: 'leaf',
      team: '',
      reportsTo,
      subagents: [],
      heartbeat: 'on-demand',
    };

    this.agents.set(name, manifest);
    return manifest;
  }

  /**
   * Unregister an ephemeral subagent.
   */
  unregisterEphemeral(name: string): boolean {
    return this.agents.delete(name);
  }

  // -----------------------------------------------------------------------
  // Internal loading
  // -----------------------------------------------------------------------

  /**
   * Ensure agents are loaded at most once. Concurrent callers share a
   * single load promise (memoized deduplication).
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = this.loadAll();
    await this.loadPromise;
  }

  /**
   * Load all agents from all sources:
   * 1. profiles.yaml (main agent)
   * 2. agents/*.md files (built-in + user-defined subagents)
   */
  private async loadAll(): Promise<void> {
    // 1. Load from profiles.yaml (main agent)
    await this.loadFromProfiles();

    // 2. Load from agents/*.md files (built-in + user-defined subagents)
    await this.loadAgentMdFiles();

    // 3. Resolve hierarchy and role-based subagent selectors now that all agents are loaded
    this.resolveHierarchyRelationships();
    this.resolveRoleBasedSubagents();

    this.loaded = true;
  }

  /**
   * Load agents from profiles.yaml.
   * Main agent is always loaded. Additional agents from agents[] array
   * are loaded as independent main agents (each gets own SOUL.md + session scope).
   * Persistent subagents from subagents[] are also loaded.
   */
  private async loadFromProfiles(): Promise<void> {
    const profilesPath = path.join(this.workspacePath, 'profiles.yaml');
    let profilesContent: string;
    try {
      profilesContent = await fs.readFile(profilesPath, 'utf-8');
    } catch {
      // profiles.yaml doesn't exist - create default
      await this.createDefaultProfiles();
      return;
    }

    const profiles = yaml.load(profilesContent) as Record<string, unknown>;

    // Load main agent (reads SOUL.md from workspace root)
    const main = (profiles['main'] as Record<string, unknown>) ?? {};
    const mainSubagentsRaw = (main['subagents'] as Record<string, unknown>) ?? {};
    const identity = await loadWorkspaceIdentity(this.workspacePath);
    const mainName =
      identity?.name?.trim() ||
      this.stringify(main['name']) ||
      '';
    this.primaryAgentName = mainName;
    const mainDescription = this.stringify(main['description']) ?? '';
    const mainRoles = this.normalizeStringArray(main['roles']);
    const mainType = (this.stringify(main['type']) as 'manager' | 'leaf' | undefined) ?? 'manager';
    const mainTeam = this.stringify(main['team']) ?? '';
    const mainReportsTo = this.stringify(main['reportsTo']) ?? '';
    const mainHeartbeatRaw = main['heartbeat'] as Record<string, unknown> | string | undefined;
    const mainHeartbeat =
      typeof mainHeartbeatRaw === 'string'
        ? mainHeartbeatRaw
        : mainHeartbeatRaw && typeof mainHeartbeatRaw === 'object'
          ? this.stringify(mainHeartbeatRaw['every']) ?? '4h'
          : '4h';
    const mainSubagentRoles = this.normalizeStringArray(
      mainSubagentsRaw['allowRoles'] ?? main['allowRoles'] ?? main['subagentRoles'],
    );
    const mainSubagentAgents = this.normalizeStringArray(
      mainSubagentsRaw['allowAgents'] ?? main['allowAgents'] ?? main['subagents'],
    );

    // Read SOUL.md for main agent instructions
    const soulPath = path.join(this.workspacePath, 'SOUL.md');
    let mainInstructions = '';
    try {
      mainInstructions = await fs.readFile(soulPath, 'utf-8');
    } catch {
      mainInstructions = `# ${mainName}\n\n${mainDescription}`;
    }

    const mainManifest: ResolvedManifest = {
      name: mainName,
      version: '1.0.0',
      description: mainDescription,
      allowedModes: ['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'],
      riskLevel: 'medium',
      permissions: { allow: ['*'], deny: [] },
      tools: { allow: [], deny: [] },
      skills: { allow: [], deny: [] },
      memory: { read: ['*'], write: ['*'] },
      outputs: ['Observation', 'Hypothesis', 'SkillManifest', 'ValidationResult', 'RiskDecision', 'PolicyDecision', 'RunCard', 'Postmortem', 'MemoryEvent'],
      approvalRequiredFor: [],
      instructions: mainInstructions,
      filename: 'profiles.yaml',
      roles: mainRoles,
      subagentRoles: mainSubagentRoles,
      type: mainType,
      team: mainTeam,
      reportsTo: mainReportsTo,
      subagents: mainSubagentAgents,
      heartbeat: mainHeartbeat,
      profiles: this.normalizeProfiles(main['profiles']),
    };

    this.agents.set(mainName, mainManifest);

    // Load additional main agents from agents[] array.
    // Each is an independent agent with own SOUL.md + session scope.
    const additionalAgents = (profiles['agents'] as Array<Record<string, unknown>>) ?? [];
    for (const agentNode of additionalAgents) {
      await this.loadAdditionalMainAgent(agentNode);
    }

    // Load persistent subagents (if defined)
    const subagents = (profiles['subagents'] as Array<Record<string, unknown>>) ?? [];
    for (const sub of subagents) {
      await this.loadProfileSubagentTree(sub, mainName);
    }
  }

  /**
   * Load an additional main agent from profiles.yaml agents[] array.
   * Each gets its own SOUL.md and session scope.
   */
  private async loadAdditionalMainAgent(node: Record<string, unknown>): Promise<void> {
    const name = this.stringify(node['name']);
    if (!name) return;

    const description = this.stringify(node['description']) ?? '';
    const roles = this.normalizeStringArray(node['roles']);
    const type = (this.stringify(node['type']) as 'manager' | 'leaf' | undefined) ?? 'manager';
    const team = this.stringify(node['team']) ?? '';
    const reportsTo = this.stringify(node['reportsTo']) ?? '';
    const subagentsConfig =
      !Array.isArray(node['subagents']) && node['subagents'] && typeof node['subagents'] === 'object'
        ? (node['subagents'] as Record<string, unknown>)
        : undefined;
    const directSubagents = this.normalizeStringArray(
      subagentsConfig?.['allowAgents'] ?? node['allowAgents'],
    );
    const subagentRoles = this.normalizeStringArray(
      subagentsConfig?.['allowRoles'] ?? node['allowRoles'],
    );

    const heartbeatRaw = node['heartbeat'] as Record<string, unknown> | string | undefined;
    const heartbeat =
      typeof heartbeatRaw === 'string'
        ? heartbeatRaw
        : heartbeatRaw && typeof heartbeatRaw === 'object'
          ? this.stringify(heartbeatRaw['every']) ?? 'on-demand'
          : 'on-demand';

    // Read SOUL.md — supports custom path via soul: field
    const soulField = this.stringify(node['soul']);
    let instructions = '';
    if (soulField) {
      // Custom soul path (relative to workspace)
      const soulPath = path.join(this.workspacePath, soulField);
      try {
        instructions = await fs.readFile(soulPath, 'utf-8');
      } catch {
        instructions = `# ${name}\n\n${description}`;
      }
    } else {
      // Default: agents/<name>/SOUL.md
      const defaultSoulPath = path.join(this.workspacePath, 'agents', name, 'SOUL.md');
      try {
        instructions = await fs.readFile(defaultSoulPath, 'utf-8');
      } catch {
        instructions = `# ${name}\n\n${description}`;
      }
    }

    const manifest: ResolvedManifest = {
      name,
      version: '1.0.0',
      description,
      allowedModes: ['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'],
      riskLevel: this.normalizeRiskLevel(node['riskLevel'] ?? 'medium'),
      permissions: { allow: ['*'], deny: [] },
      tools: { allow: [], deny: [] },
      skills: { allow: [], deny: [] },
      memory: { read: ['*'], write: ['*'] },
      outputs: ['Observation', 'Hypothesis', 'SkillManifest', 'ValidationResult', 'RiskDecision', 'PolicyDecision', 'RunCard', 'Postmortem', 'MemoryEvent'],
      approvalRequiredFor: this.normalizeStringArray(node['approvalRequiredFor'] ?? []),
      instructions,
      filename: `profiles.yaml:agents.${name}`,
      roles,
      subagentRoles,
      type,
      team,
      reportsTo,
      subagents: directSubagents,
      heartbeat,
      profiles: this.normalizeProfiles(node['profiles']),
    };

    this.agents.set(name, manifest);
  }

  /**
   * Create default profiles.yaml with just the main agent.
   */
  private async createDefaultProfiles(): Promise<void> {
    const defaultProfiles = `# DynaTrader Profiles
# Configure your main agent and optional persistent subagents.

main:
  name: ""
  description: ""
  type: manager
  team: ""
  reportsTo: ""
  roles: []
  heartbeat:
    every: 4h
  # max_subagents: <set explicitly>
  # max_spawn_depth: <set explicitly>

# Optional persistent subagents
# Define these only if you want operator-managed agents in agents/<name>/.
# subagents:
#   - name: <your-agent-name>
#     description: Describe the role this subagent should play
#     subagents:
#       - name: <child-agent-name>
#         description: Nested child agents are supported too
    `;

    await fs.writeFile(path.join(this.workspacePath, 'profiles.yaml'), defaultProfiles, 'utf-8');

    // Re-read the file we just created
    await this.loadFromProfiles();
  }

  /**
   * Recursively load a persistent subagent node from profiles.yaml.
   *
   * This supports hierarchical agent nesting where a main agent can own
   * persistent subagents and those subagents can in turn own children.
   */
  private async loadProfileSubagentTree(
    node: Record<string, unknown>,
    parentName: string,
  ): Promise<void> {
    const name = this.stringify(node['name']);
    if (!name) return;

    const description = this.stringify(node['description']) ?? '';
    const roles = this.normalizeStringArray(node['roles']);
    const parent = this.stringify(node['parent']) ?? this.stringify(node['reportsTo']) ?? parentName;
    const subagentsConfig =
      !Array.isArray(node['subagents']) && node['subagents'] && typeof node['subagents'] === 'object'
        ? (node['subagents'] as Record<string, unknown>)
        : undefined;
    const directSubagents = this.normalizeStringArray(
      subagentsConfig?.['allowAgents'] ?? node['allowAgents'],
    );
    const subagentRoles = this.normalizeStringArray(
      subagentsConfig?.['allowRoles'] ?? node['allowRoles'],
    );
    const subDir = path.join(this.workspacePath, 'agents', name);
    const subSoulPath = path.join(subDir, 'SOUL.md');

    let subInstructions = '';
    try {
      subInstructions = await fs.readFile(subSoulPath, 'utf-8');
    } catch {
      subInstructions = `# ${name}\n\n${description}`;
    }

    const heartbeatRaw = node['heartbeat'] as Record<string, unknown> | string | undefined;
    const heartbeat =
      typeof heartbeatRaw === 'string'
        ? heartbeatRaw
        : heartbeatRaw && typeof heartbeatRaw === 'object'
          ? this.stringify(heartbeatRaw['every']) ?? 'on-demand'
          : 'on-demand';

    const subManifest: ResolvedManifest = {
      name,
      version: this.stringify(node['version']) ?? '1.0.0',
      description,
      allowedModes: ['research', 'paper'],
      riskLevel: this.normalizeRiskLevel(node['riskLevel'] ?? 'low'),
      permissions: { allow: ['read_memory', 'write_memory'], deny: [] },
      tools: { allow: [], deny: [] },
      skills: { allow: [], deny: [] },
      memory: { read: [], write: [] },
      outputs: this.normalizeArtifactTypes(node['outputs'] ?? []),
      approvalRequiredFor: this.normalizeStringArray(node['approvalRequiredFor'] ?? []),
      instructions: subInstructions,
      filename: `agents/${name}`,
      roles,
      subagentRoles,
      type: (this.stringify(node['type']) as 'manager' | 'leaf' | undefined) ?? 'leaf',
      team: this.stringify(node['team']) ?? '',
      reportsTo: parent,
      subagents: directSubagents,
      heartbeat,
      profiles: this.normalizeProfiles(node['profiles']),
    };

    this.agents.set(name, subManifest);

    const nested = [
      ...(Array.isArray(node['children']) ? node['children'] : []),
      ...((Array.isArray(node['subagents']) ? node['subagents'] : []) as Array<Record<string, unknown>>),
    ];
    for (const child of nested) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      if (this.stringify((child as Record<string, unknown>)['name']) === undefined) continue;
      await this.loadProfileSubagentTree(child as Record<string, unknown>, name);
    }
  }

  private getPrimaryAgentName(): string {
    return this.primaryAgentName;
  }

  /**
   * Scan workspace/agents/ for .md files and load them as agent definitions.
   * This follows the OpenCode pattern where agents are defined as markdown files
   * with YAML frontmatter containing metadata (description, mode, permission).
   *
   * File format:
   *   agents/<name>.md
   *     ---
   *     description: Agent description
   *     mode: subagent
   *     permission:
   *       web_search: allow
   *       read: allow
   *       write: deny
   *     ---
   *     Agent instructions go here...
   *
   * Built-in agents (general.md, explore.md) are loaded first.
   * User-defined agents can extend or override them.
   */
  private async loadAgentMdFiles(): Promise<void> {
    const agentsDir = path.join(this.workspacePath, 'agents');
    let entries: string[];
    try {
      entries = await fs.readdir(agentsDir);
    } catch {
      // agents/ directory does not exist — nothing to load
      return;
    }

    for (const entry of entries) {
      // Only load .md files (skip directories and other files)
      if (!entry.endsWith('.md')) continue;

      const filePath = path.join(agentsDir, entry);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;

      const manifest = await this.loadAgentMdFile(entry, filePath);
      if (manifest) {
        this.agents.set(manifest.name, manifest);
      }
    }
  }

  /**
   * Load an agent from a markdown file with YAML frontmatter.
   * Format follows OpenCode's agent definition pattern.
   */
  private async loadAgentMdFile(
    fileName: string,
    filePath: string,
  ): Promise<ResolvedManifest | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const name = fileName.replace(/\.md$/, '');

      // Parse YAML frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!frontmatterMatch) {
        // No frontmatter - use filename as name and entire content as instructions
        return {
          name,
          version: '1.0.0',
          description: `Agent: ${name}`,
          allowedModes: ['research', 'paper'],
          riskLevel: 'low',
          permissions: { allow: ['read_memory'], deny: [] },
          tools: { allow: [], deny: [] },
          skills: { allow: [], deny: [] },
          memory: { read: [], write: [] },
          outputs: ['Observation'],
          approvalRequiredFor: [],
          instructions: content.trim(),
          filename: fileName,
          type: 'leaf',
          team: '',
          reportsTo: '',
          subagents: [],
          heartbeat: 'on-demand',
        };
      }

      const [, frontmatterStr, body] = frontmatterMatch;
      const fm = yaml.load(frontmatterStr) as Record<string, unknown>;

      const description = this.stringify(fm['description']) ?? `Agent: ${name}`;
      const mode = this.stringify(fm['mode']) ?? 'subagent';
      const type = mode === 'primary' ? 'manager' : 'leaf';

      // Parse permissions from frontmatter
      const permissionRaw = fm['permission'] as Record<string, unknown> | undefined;
      const toolsAllow: string[] = [];
      const toolsDeny: string[] = [];

      if (permissionRaw) {
        for (const [tool, access] of Object.entries(permissionRaw)) {
          const accessStr = this.stringify(access)?.toLowerCase();
          if (accessStr === 'allow') {
            toolsAllow.push(tool);
          } else if (accessStr === 'deny') {
            toolsDeny.push(tool);
          }
        }
      }

      // Parse model override
      const model = this.stringify(fm['model']);

      // Parse temperature
      const temperature = typeof fm['temperature'] === 'number' ? fm['temperature'] : undefined;

      return {
        name,
        version: '1.0.0',
        description,
        allowedModes: ['research', 'paper'],
        riskLevel: 'low',
        permissions: { allow: ['read_memory'], deny: [] },
        tools: { allow: toolsAllow, deny: toolsDeny },
        skills: { allow: [], deny: [] },
        memory: { read: [], write: [] },
        outputs: ['Observation'],
        approvalRequiredFor: [],
        instructions: body.trim(),
        filename: fileName,
        type: type as 'manager' | 'leaf',
        team: '',
        reportsTo: '',
        subagents: [],
        heartbeat: 'on-demand',
        profiles: this.normalizeProfiles(fm['profiles']),
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Normalisation helpers
  // -----------------------------------------------------------------------

  private stringify(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  }

  private normalizeModes(raw: unknown): RuntimeMode[] {
    const valid: RuntimeMode[] = [
      'research', 'backtest', 'paper', 'shadow', 'micro_live', 'live',
    ];
    if (!Array.isArray(raw)) return [];
    return raw.filter((m): m is RuntimeMode => valid.includes(m as RuntimeMode));
  }

  private normalizeRiskLevel(raw: unknown): RiskLevel {
    const valid: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const s = this.stringify(raw)?.toLowerCase() ?? 'low';
    return valid.includes(s as RiskLevel) ? (s as RiskLevel) : 'low';
  }

  private normalizePermissions(raw: unknown): PermissionSet {
    if (!raw || typeof raw !== 'object') return { allow: [], deny: [] };
    const r = raw as Record<string, unknown>;
    return {
      allow: this.normalizeStringArray(r['allow']),
      deny: this.normalizeStringArray(r['deny']),
    };
  }

  private normalizeSkillPermissions(raw: unknown): SkillPermissions {
    if (!raw || typeof raw !== 'object') return { allow: [], deny: [] };
    const r = raw as Record<string, unknown>;
    return {
      allow: this.normalizeStringArray(r['allow']),
      deny: this.normalizeStringArray(r['deny']),
    };
  }

  private normalizeMemoryPermissions(raw: unknown): MemoryPermissions {
    if (!raw || typeof raw !== 'object') return { read: [], write: [] };
    const r = raw as Record<string, unknown>;
    return {
      read: this.normalizeStringArray(r['read']),
      write: this.normalizeStringArray(r['write']),
    };
  }

  private normalizeArtifactTypes(raw: unknown): ArtifactType[] {
    const valid: ArtifactType[] = [
      'Observation', 'Hypothesis', 'SkillManifest', 'ValidationResult',
      'RiskDecision', 'PolicyDecision', 'RunCard', 'Postmortem', 'MemoryEvent',
    ];
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is ArtifactType => valid.includes(t as ArtifactType));
  }

  private normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private normalizeProfiles(raw: unknown): ToolProfile[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const valid: ToolProfile[] = [
      'base', 'memory', 'multi_agent', 'messaging', 'media', 'browser',
      'trading', 'risk',
    ];
    const profiles = raw
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ToolProfile => valid.includes(s as ToolProfile));
    return profiles.length > 0 ? profiles : undefined;
  }

  private resolveRoleBasedSubagents(): void {
    const agents = Array.from(this.agents.values());
    const roleIndex = new Map<string, Set<string>>();

    for (const agent of agents) {
      for (const role of agent.roles ?? []) {
        if (!roleIndex.has(role)) {
          roleIndex.set(role, new Set<string>());
        }
        roleIndex.get(role)!.add(agent.name);
      }
    }

    for (const agent of agents) {
      if (!agent.subagentRoles?.length) continue;
      const resolved = new Set<string>(agent.subagents.filter((name) => name !== '*'));
      for (const role of agent.subagentRoles) {
        const matches = roleIndex.get(role);
        if (!matches) continue;
        for (const name of matches) {
          if (name !== agent.name) {
            resolved.add(name);
          }
        }
      }
      agent.subagents = Array.from(resolved);
    }
  }

  private resolveHierarchyRelationships(): void {
    const agents = Array.from(this.agents.values());
    const byName = new Map(agents.map((agent) => [agent.name, agent] as const));

    for (const agent of agents) {
      const parentName = agent.reportsTo?.trim();
      if (!parentName) continue;
      if (parentName === agent.name) continue;

      const parent = byName.get(parentName);
      if (!parent) continue;

      const merged = new Set<string>(parent.subagents.filter((name) => name !== agent.name));
      merged.add(agent.name);
      parent.subagents = Array.from(merged);
      if (parent.type !== 'manager') {
        parent.type = 'manager';
      }
    }
  }
}
