/**
 * Agent Profile Manager
 *
 * CRUD operations for agent profiles. Handles creation, update,
 * deletion, and listing of agent profiles in the workspace.
 *
 * Profile structure:
 *   workspace/agents/<name>/
 *     profile.yaml    - Agent metadata (permissions, tools, modes)
 *     SOUL.md         - Agent personality and instructions
 *     IDENTITY.md     - Optional team/reportsTo metadata
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { randomUUID } from 'crypto';
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
// ResolvedManifest type is used for type hints only

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProfileCreateRequest {
  /** Unique agent name (used as directory name). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Agent personality/instructions (Markdown). */
  soul: string;
  /** Agent type. */
  type?: 'manager' | 'leaf';
  /** Team this agent belongs to. */
  team?: string;
  /** Parent agent name. */
  reportsTo?: string;
  /** Semantic role tags. */
  roles?: string[];
  /** Allowed runtime modes. */
  allowedModes?: RuntimeMode[];
  /** Risk level. */
  riskLevel?: RiskLevel;
  /** Permission grants. */
  permissions?: PermissionSet;
  /** Tool permissions. */
  tools?: ToolPermissions;
  /** Skill permissions. */
  skills?: SkillPermissions;
  /** Memory permissions. */
  memory?: MemoryPermissions;
  /** Output artifact types. */
  outputs?: ArtifactType[];
  /** Approval required for these actions. */
  approvalRequiredFor?: string[];
  /** Heartbeat interval (e.g., '4h', '30m', 'on-demand'). */
  heartbeat?: string;
}

export interface AgentProfileUpdateRequest {
  /** Description update. */
  description?: string;
  /** Soul/instructions update. */
  soul?: string;
  /** Agent type. */
  type?: 'manager' | 'leaf';
  /** Team. */
  team?: string;
  /** Parent agent. */
  reportsTo?: string;
  /** Roles. */
  roles?: string[];
  /** Allowed modes. */
  allowedModes?: RuntimeMode[];
  /** Risk level. */
  riskLevel?: RiskLevel;
  /** Permissions. */
  permissions?: PermissionSet;
  /** Tools. */
  tools?: ToolPermissions;
  /** Skills. */
  skills?: SkillPermissions;
  /** Memory. */
  memory?: MemoryPermissions;
  /** Outputs. */
  outputs?: ArtifactType[];
  /** Approval required. */
  approvalRequiredFor?: string[];
  /** Heartbeat. */
  heartbeat?: string;
}

export interface AgentProfileSummary {
  name: string;
  description: string;
  type: 'manager' | 'leaf';
  team: string;
  reportsTo: string;
  roles: string[];
  riskLevel: RiskLevel;
  allowedModes: RuntimeMode[];
  heartbeat: string;
  path: string;
}

// ---------------------------------------------------------------------------
// AgentProfileManager
// ---------------------------------------------------------------------------

export class AgentProfileManager {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  // -----------------------------------------------------------------------
  // CRUD Operations
  // -----------------------------------------------------------------------

  /**
   * Create a new agent profile.
   * Creates the directory structure with profile.yaml and SOUL.md.
   */
  async create(request: AgentProfileCreateRequest): Promise<AgentProfileSummary> {
    const agentDir = path.join(this.workspacePath, 'agents', request.name);

    // Check if agent already exists
    try {
      await fs.access(agentDir);
      throw new Error(`Agent "${request.name}" already exists`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Create directory
    await fs.mkdir(agentDir, { recursive: true });

    // Create profile.yaml
    const profile: Record<string, unknown> = {
      id: request.name,
      version: '1.0.0',
      description: request.description,
      type: request.type ?? 'leaf',
      team: request.team ?? '',
      reportsTo: request.reportsTo ?? '',
      roles: request.roles ?? [],
      heartbeat: { every: request.heartbeat ?? 'on-demand' },
      riskLevel: request.riskLevel ?? 'low',
      permissions: {
        allowedModes: request.allowedModes ?? ['research', 'paper'],
        allow: request.permissions?.allow ?? ['read_memory', 'write_memory'],
        deny: request.permissions?.deny ?? [],
      },
      tools: request.tools ?? { allow: [], deny: [] },
      outputs: request.outputs ?? ['Observation', 'Hypothesis'],
      approvalRequiredFor: request.approvalRequiredFor ?? [],
    };

    await fs.writeFile(
      path.join(agentDir, 'profile.yaml'),
      yaml.dump(profile, { lineWidth: -1 }),
      'utf-8',
    );

    // Create SOUL.md
    await fs.writeFile(
      path.join(agentDir, 'SOUL.md'),
      request.soul,
      'utf-8',
    );

    // Create IDENTITY.md
    const identity = [
      `# ${request.name}`,
      '',
      `## Team`,
      request.team ?? '',
      '',
      `## Reports To`,
      request.reportsTo ?? '',
      '',
      `## Type`,
      request.type ?? 'leaf',
    ].join('\n');

    await fs.writeFile(
      path.join(agentDir, 'IDENTITY.md'),
      identity,
      'utf-8',
    );

    return this.getSummary(request.name);
  }

  /**
   * Get an agent profile summary.
   */
  async get(name: string): Promise<AgentProfileSummary> {
    return this.getSummary(name);
  }

  /**
   * Update an existing agent profile.
   */
  async update(name: string, request: AgentProfileUpdateRequest): Promise<AgentProfileSummary> {
    const agentDir = path.join(this.workspacePath, 'agents', name);

    // Verify agent exists
    try {
      await fs.access(agentDir);
    } catch {
      throw new Error(`Agent "${name}" not found`);
    }

    // Update profile.yaml
    if (request.description || request.type || request.team || request.reportsTo ||
        request.roles || request.allowedModes || request.riskLevel || request.permissions ||
        request.tools || request.skills || request.memory || request.outputs ||
        request.approvalRequiredFor || request.heartbeat) {
      const profilePath = path.join(agentDir, 'profile.yaml');
      let profile: Record<string, unknown>;
      try {
        const content = await fs.readFile(profilePath, 'utf-8');
        profile = yaml.load(content) as Record<string, unknown>;
      } catch {
        profile = { id: name, version: '1.0.0' };
      }

      if (request.description) profile['description'] = request.description;
      if (request.type) profile['type'] = request.type;
      if (request.team) profile['team'] = request.team;
      if (request.reportsTo) profile['reportsTo'] = request.reportsTo;
      if (request.roles) profile['roles'] = request.roles;
      if (request.riskLevel) profile['riskLevel'] = request.riskLevel;
      if (request.heartbeat) profile['heartbeat'] = { every: request.heartbeat };
      if (request.outputs) profile['outputs'] = request.outputs;
      if (request.approvalRequiredFor) profile['approvalRequiredFor'] = request.approvalRequiredFor;

      if (request.allowedModes || request.permissions) {
        const permissions = (profile['permissions'] as Record<string, unknown>) ?? {};
        if (request.allowedModes) permissions['allowedModes'] = request.allowedModes;
        if (request.permissions) {
          permissions['allow'] = request.permissions.allow;
          permissions['deny'] = request.permissions.deny;
        }
        profile['permissions'] = permissions;
      }

      if (request.tools) profile['tools'] = request.tools;

      await fs.writeFile(profilePath, yaml.dump(profile, { lineWidth: -1 }), 'utf-8');
    }

    // Update SOUL.md
    if (request.soul) {
      await fs.writeFile(path.join(agentDir, 'SOUL.md'), request.soul, 'utf-8');
    }

    // Update IDENTITY.md
    const identity = [
      `# ${name}`,
      '',
      `## Team`,
      request.team ?? '',
      '',
      `## Reports To`,
      request.reportsTo ?? '',
      '',
      `## Type`,
      request.type ?? 'leaf',
    ].join('\n');

    await fs.writeFile(path.join(agentDir, 'IDENTITY.md'), identity, 'utf-8');

    return this.getSummary(name);
  }

  /**
   * Delete an agent profile.
   */
  async delete(name: string): Promise<boolean> {
    const agentDir = path.join(this.workspacePath, 'agents', name);

    try {
      await fs.access(agentDir);
    } catch {
      return false;
    }

    // Archive instead of delete (safety)
    const archiveDir = path.join(this.workspacePath, 'agents', '.archived', `${name}-${Date.now()}`);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.rename(agentDir, archiveDir);

    return true;
  }

  /**
   * List all agent profiles.
   */
  async list(): Promise<AgentProfileSummary[]> {
    const agentsDir = path.join(this.workspacePath, 'agents');
    let entries: string[];
    try {
      entries = await fs.readdir(agentsDir);
    } catch {
      return [];
    }

    const summaries: AgentProfileSummary[] = [];

    for (const entry of entries) {
      if (entry.startsWith('.')) continue; // Skip hidden/archived

      const entryPath = path.join(agentsDir, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      try {
        const summary = await this.getSummary(entry);
        summaries.push(summary);
      } catch {
        // Skip invalid agents
      }
    }

    return summaries;
  }

  /**
   * Check if an agent exists.
   */
  async exists(name: string): Promise<boolean> {
    const agentDir = path.join(this.workspacePath, 'agents', name);
    try {
      await fs.access(path.join(agentDir, 'profile.yaml'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get agent SOUL.md content.
   */
  async getSoul(name: string): Promise<string> {
    const soulPath = path.join(this.workspacePath, 'agents', name, 'SOUL.md');
    try {
      return await fs.readFile(soulPath, 'utf-8');
    } catch {
      throw new Error(`SOUL.md not found for agent "${name}"`);
    }
  }

  /**
   * Update agent SOUL.md content.
   */
  async updateSoul(name: string, soul: string): Promise<void> {
    const agentDir = path.join(this.workspacePath, 'agents', name);
    try {
      await fs.access(agentDir);
    } catch {
      throw new Error(`Agent "${name}" not found`);
    }

    await fs.writeFile(path.join(agentDir, 'SOUL.md'), soul, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private async getSummary(name: string): Promise<AgentProfileSummary> {
    const agentDir = path.join(this.workspacePath, 'agents', name);
    const profilePath = path.join(agentDir, 'profile.yaml');

    let profile: Record<string, unknown>;
    try {
      const content = await fs.readFile(profilePath, 'utf-8');
      profile = yaml.load(content) as Record<string, unknown>;
    } catch {
      throw new Error(`Agent "${name}" not found or invalid profile.yaml`);
    }

    const permissions = (profile['permissions'] as Record<string, unknown>) ?? {};
    const heartbeatRaw = profile['heartbeat'] as Record<string, unknown> | undefined;

    return {
      name,
      description: (profile['description'] as string) ?? '',
      type: (profile['type'] as 'manager' | 'leaf') ?? 'leaf',
      team: (profile['team'] as string) ?? '',
      reportsTo: (profile['reportsTo'] as string) ?? '',
      roles: Array.isArray(profile['roles']) ? profile['roles'] as string[] : [],
      riskLevel: (profile['riskLevel'] as RiskLevel) ?? 'low',
      allowedModes: Array.isArray(permissions['allowedModes'])
        ? permissions['allowedModes'] as RuntimeMode[]
        : ['research', 'paper'],
      heartbeat: heartbeatRaw?.['every'] as string ?? 'on-demand',
      path: agentDir,
    };
  }
}
