import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { AuditTrail, type AuditEvent } from '@dyna/audit';
import { AuthRuntime } from '@dyna/auth-runtime';
import { PermissionRuntime, type PermissionContext } from '@dyna/permission-runtime';
import { EventBus } from '@dyna/event-bus';
import {
  type SkillManifest,
  type RuntimeMode,
  type RiskLevel,
  type PermissionSet,
  type SkillSecurity,
  type SkillReview,
  type SkillStatus,
} from '@dyna/workspace';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const SkillJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  status: z.enum([
    'draft', 'validated', 'sandboxed', 'backtested', 'paper_approved',
    'shadow_eligible', 'micro_live_eligible', 'live_eligible', 'deprecated',
  ]),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  toolsRequired: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  inputs: z.unknown().optional(),
  outputs: z.unknown().optional(),
  review: z.object({
    humanRequired: z.boolean(),
    testsRequired: z.boolean(),
    signatureRequired: z.boolean(),
  }),
  security: z.object({
    allowNetwork: z.boolean(),
    allowFilesystem: z.boolean(),
    allowCredentials: z.boolean(),
    allowOrderExecution: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * A fully loaded skill descriptor loaded from the workspace filesystem.
 */
export interface SkillDescriptor {
  /** Unique skill name (matches directory name). */
  name: string;
  /** Version from skill.json. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Directory name under workspace/skills/. */
  directory: string;
  /** Parsed skill manifest. */
  manifest: SkillManifest;
  /** Raw SKILL.md instructions content. */
  instructions: string;
  /** Full filesystem path to the skill directory. */
  path: string;
}

/**
 * Request to execute a skill.
 */
export interface SkillExecutionRequest {
  /** Name of the skill to execute (must match a loaded skill). */
  skillName: string;
  /** Input payload passed into the skill. */
  input: Record<string, unknown>;
  /** Execution context describing who/what is invoking. */
  context: {
    mode: RuntimeMode;
    actor: string;
    actorType: 'user' | 'subagent' | 'skill' | 'system';
    correlationId: string;
  };
  /** Optional scoped credentials (enforced by policy). */
  credentials?: Record<string, string>;
}

/**
 * Result of a skill execution.
 */
export interface SkillExecutionResult {
  skillName: string;
  success: boolean;
  output: Record<string, unknown>;
  error?: string;
  durationMs: number;
  auditEventId: string;
}

/**
 * Options for constructing a SkillRuntime.
 */
export interface SkillRuntimeOptions {
  /** Path to the workspace directory (e.g. ./workspace). */
  workspacePath: string;
  /** Shared auth runtime instance. */
  authRuntime: AuthRuntime;
  /** Shared permission runtime instance. */
  permissionRuntime: PermissionRuntime;
  /** Shared audit trail instance. */
  auditTrail: AuditTrail;
  /** Shared event bus instance. */
  eventBus: EventBus;
  /** When true, denials throw instead of returning errors. */
  strictMode?: boolean;
}

// ---------------------------------------------------------------------------
// Sandbox enforcement helpers
// ---------------------------------------------------------------------------

/**
 * A set of constraints derived from a skill's security block and the
 * effective runtime mode.
 */
export interface SandboxConstraints {
  /** Whether network access is allowed. */
  allowNetwork: boolean;
  /** Whether arbitrary filesystem access is allowed. */
  allowFilesystem: boolean;
  /** Whether credential access is allowed. */
  allowCredentials: boolean;
  /** Whether direct order execution is allowed. */
  allowOrderExecution: boolean;
  /** Tool names the skill is explicitly allowed to call. */
  allowedTools: string[];
  /** Tool names the skill is explicitly denied from calling. */
  deniedTools: string[];
  /** Modes the skill is allowed to run in. */
  allowedModes: RuntimeMode[];
}

// ---------------------------------------------------------------------------
// SkillRuntime implementation
// ---------------------------------------------------------------------------

/**
 * SkillRuntime loads skill manifests from `workspace/skills/<name>/skill.json`
 * + `SKILL.md`, validates permissions / allowed modes / security constraints,
 * executes skills in a (logically) sandboxed context, and audits every
 * execution.
 */
export class SkillRuntime {
  private readonly workspacePath: string;
  private readonly authRuntime: AuthRuntime;
  private readonly permissionRuntime: PermissionRuntime;
  private readonly auditTrail: AuditTrail;
  private readonly eventBus: EventBus;
  private readonly strictMode: boolean;

  /** Loaded skill descriptors keyed by name. */
  private loadedSkills: Map<string, SkillDescriptor> = new Map();

  constructor(options: SkillRuntimeOptions) {
    this.workspacePath = options.workspacePath;
    this.authRuntime = options.authRuntime;
    this.permissionRuntime = options.permissionRuntime;
    this.auditTrail = options.auditTrail;
    this.eventBus = options.eventBus;
    this.strictMode = options.strictMode ?? true;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Scan workspace/skills/ directories and load each skill's manifest +
   * instructions.
   */
  async loadSkills(): Promise<SkillDescriptor[]> {
    const skillsDir = path.join(this.workspacePath, 'skills');
    let entries: import('fs').Dirent[];
    try {
      await fs.access(skillsDir);
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      // No skills directory -- nothing to load.
      return [];
    }

    const descriptors: SkillDescriptor[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDirPath = path.join(skillsDir, entry.name);
      const skillJsonPath = path.join(skillDirPath, 'skill.json');
      const skillMdPath = path.join(skillDirPath, 'SKILL.md');

      try {
        await fs.access(skillJsonPath);
        await fs.access(skillMdPath);
      } catch {
        // Incomplete skill directory -- skip silently.
        continue;
      }

      const rawJson = await fs.readFile(skillJsonPath, 'utf-8');
      const instructions = await fs.readFile(skillMdPath, 'utf-8');

      let parsedJson: Record<string, unknown>;
      try {
        parsedJson = JSON.parse(rawJson);
      } catch {
        // Invalid JSON -- skip.
        continue;
      }

      const validation = SkillJsonSchema.safeParse(parsedJson);
      if (!validation.success) {
        // Invalid manifest structure -- skip.
        continue;
      }

      const manifest = this.toSkillManifest(validation.data);

      const descriptor: SkillDescriptor = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        directory: entry.name,
        manifest,
        instructions,
        path: skillDirPath,
      };

      this.loadedSkills.set(descriptor.name, descriptor);
      descriptors.push(descriptor);
    }

    return descriptors;
  }

  /**
   * Return all currently loaded skill descriptors.
   */
  getLoadedSkills(): SkillDescriptor[] {
    return Array.from(this.loadedSkills.values());
  }

  /**
   * Look up a single loaded skill by name.
   */
  getSkill(name: string): SkillDescriptor | undefined {
    return this.loadedSkills.get(name);
  }

  /**
   * Validate whether a loaded skill may be executed under the given mode.
   * Returns a list of rejection reasons (empty = valid).
   */
  validateSkill(name: string, mode: RuntimeMode): string[] {
    const skill = this.loadedSkills.get(name);
    if (!skill) return [`Skill "${name}" not found or not loaded`];

    const reasons: string[] = [];

    // 1. Check skill status -- deprecated skills should not run.
    if (skill.manifest.status === 'deprecated') {
      reasons.push(`Skill "${name}" is deprecated`);
    }

    // 2. Check allowed modes.
    if (!skill.manifest.allowedModes.includes(mode)) {
      reasons.push(
        `Skill "${name}" does not allow mode "${mode}". Allowed: ${skill.manifest.allowedModes.join(', ')}`,
      );
    }

    // 3. Security constraints that affect viability.
    const security = skill.manifest.security;

    // 4. Check review requirements.
    const review = skill.manifest.review;
    if (review.humanRequired && mode !== 'research' && mode !== 'backtest') {
      reasons.push(
        `Skill "${name}" requires human review before execution in ${mode} mode`,
      );
    }
    if (review.signatureRequired) {
      reasons.push(`Skill "${name}" requires a cryptographic signature`);
    }

    return reasons;
  }

  /**
   * Compute the effective sandbox constraints for a skill when running under
   * the given mode.
   */
  getSandboxConstraints(name: string, mode: RuntimeMode): SandboxConstraints {
    const skill = this.loadedSkills.get(name);
    if (!skill) {
      return {
        allowNetwork: false,
        allowFilesystem: false,
        allowCredentials: false,
        allowOrderExecution: false,
        allowedTools: [],
        deniedTools: [],
        allowedModes: [],
      };
    }

    const sec = skill.manifest.security;
    const perm = skill.manifest.permissions;
    const isHighRisk = ['paper', 'shadow', 'micro_live', 'live'].includes(mode);

    return {
      allowNetwork: sec.allowNetwork && !isHighRisk,
      allowFilesystem: sec.allowFilesystem && mode === 'research',
      allowCredentials: sec.allowCredentials,
      allowOrderExecution: false, // Always denied regardless of manifest for safety; must be explicitly policy-approved
      allowedTools: perm.allow,
      deniedTools: perm.deny,
      allowedModes: skill.manifest.allowedModes,
    };
  }

  /**
   * Execute a skill under the sandboxed execution context.
   *
   * This method performs all permission & security checks *before* running
   * the skill's instructions. The actual execution is simulated (the sandbox
   * evaluates what the skill would do against the constraints).
   */
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const correlationId = request.context.correlationId || uuidv4();

    // 1. Resolve the skill.
    const skill = this.loadedSkills.get(request.skillName);
    if (!skill) {
      return this.buildErrorResult(request.skillName, startTime, `Skill "${request.skillName}" not loaded`);
    }

    // 2. Validate skill against the requested mode.
    const validationErrors = this.validateSkill(request.skillName, request.context.mode);
    if (validationErrors.length > 0) {
      const msg = validationErrors.join('; ');
      await this.auditExecution(skill, request, 'denied', msg, startTime);
      if (this.strictMode) throw new Error(msg);
      return this.buildErrorResult(request.skillName, startTime, msg);
    }

    // 3. Permission check via PermissionRuntime.
    const permContext: PermissionContext = {
      actor: request.context.actor,
      actorType: request.context.actorType,
      action: `skill:execute:${request.skillName}`,
      resource: `skill://${request.skillName}`,
      mode: request.context.mode,
    };
    const permCheck = await this.permissionRuntime.checkPermission(permContext);
    if (!permCheck.allowed) {
      const msg = `Permission denied for skill "${request.skillName}": ${permCheck.reasons.join('; ')}`;
      await this.auditExecution(skill, request, 'denied', msg, startTime);
      if (this.strictMode) throw new Error(msg);
      return this.buildErrorResult(request.skillName, startTime, msg);
    }

    // 4. Enforce no direct trade execution.
    const constraints = this.getSandboxConstraints(request.skillName, request.context.mode);
    if (constraints.allowOrderExecution) {
      const msg = `Skill "${request.skillName}" is not allowed to execute trades directly`;
      await this.auditExecution(skill, request, 'denied', msg, startTime);
      if (this.strictMode) throw new Error(msg);
      return this.buildErrorResult(request.skillName, startTime, msg);
    }

    // 5. Enforce credential access policy.
    if (request.credentials && Object.keys(request.credentials).length > 0) {
      if (!constraints.allowCredentials) {
        const msg = `Skill "${request.skillName}" is not allowed to access credentials`;
        await this.auditExecution(skill, request, 'denied', msg, startTime);
        if (this.strictMode) throw new Error(msg);
        return this.buildErrorResult(request.skillName, startTime, msg);
      }
    }

    // 6. Tool allow/deny enforcement simulation.
    //    Any tool call would be validated against allowedTools / deniedTools.
    const requestedTools = this.extractToolNames(request.input);
    for (const tool of requestedTools) {
      if (constraints.deniedTools.includes(tool)) {
        const msg = `Skill "${request.skillName}" tried to call denied tool "${tool}"`;
        await this.auditExecution(skill, request, 'denied', msg, startTime);
        if (this.strictMode) throw new Error(msg);
        return this.buildErrorResult(request.skillName, startTime, msg);
      }
      if (
        constraints.allowedTools.length > 0 &&
        !constraints.allowedTools.includes(tool)
      ) {
        const msg = `Skill "${request.skillName}" tried to call tool "${tool}" which is not in the allowed list`;
        await this.auditExecution(skill, request, 'denied', msg, startTime);
        if (this.strictMode) throw new Error(msg);
        return this.buildErrorResult(request.skillName, startTime, msg);
      }
    }

    // 7. Execute the skill (sandboxed).
    try {
      const output = await this.runSandboxed(skill, request, constraints);
      const durationMs = Date.now() - startTime;

      const auditId = await this.auditExecution(skill, request, 'approved', undefined, startTime);

      // Emit a bus event.
      await this.emitExecutionEvent(skill, request, 'success', durationMs);

      return {
        skillName: request.skillName,
        success: true,
        output,
        durationMs,
        auditEventId: auditId,
      };
    } catch (execError: unknown) {
      const durationMs = Date.now() - startTime;
      const msg = execError instanceof Error ? execError.message : String(execError);

      await this.auditExecution(skill, request, 'failure', msg, startTime);
      await this.emitExecutionEvent(skill, request, 'failure', durationMs);

      if (this.strictMode) throw execError;
      return this.buildErrorResult(request.skillName, startTime, msg);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Run a skill in a (logically) sandboxed context. Currently returns a
   * simple result that wraps the input. In production this would invoke a
   * VM/fork/sandboxed process.
   */
  private async runSandboxed(
    skill: SkillDescriptor,
    request: SkillExecutionRequest,
    _constraints: SandboxConstraints,
  ): Promise<Record<string, unknown>> {
    // Simulated sandbox: merge input with skill info + instructions.
    return {
      skillName: skill.name,
      skillVersion: skill.version,
      instructionsPreview: skill.instructions.slice(0, 200),
      inputReceived: request.input,
      result: 'execution_completed',
    };
  }

  /**
   * Record an audit event for skill execution.
   * Returns the audit event id.
   */
  private async auditExecution(
    skill: SkillDescriptor,
    request: SkillExecutionRequest,
    result: 'approved' | 'denied' | 'failure',
    reason?: string,
    startTime?: number,
  ): Promise<string> {
    const auditEventId = uuidv4();
    const event: Omit<AuditEvent, 'id' | 'timestamp'> = {
      type: 'action',
      actor: request.context.actor,
      actorType: request.context.actorType,
      action: `skill:execute:${request.skillName}`,
      resource: `skill://${request.skillName}@${skill.version}`,
      result: result === 'approved' ? 'success' : result === 'denied' ? 'denied' : 'failure',
      details: {
        skillName: request.skillName,
        skillVersion: skill.version,
        mode: request.context.mode,
        correlationId: request.context.correlationId,
        inputKeys: Object.keys(request.input),
        hasCredentials: request.credentials != null && Object.keys(request.credentials).length > 0,
        durationMs: startTime ? Date.now() - startTime : undefined,
        reason,
      },
      metadata: {
        auditEventId,
      },
    };

    await this.auditTrail.record(event);
    return auditEventId;
  }

  /**
   * Emit an execution event on the event bus.
   */
  private async emitExecutionEvent(
    skill: SkillDescriptor,
    request: SkillExecutionRequest,
    status: 'success' | 'failure',
    durationMs: number,
  ): Promise<void> {
    await this.eventBus.emit('agent', {
      type: 'skill_execution_completed',
      timestamp: new Date(),
      data: {
        skillName: skill.name,
        status,
        durationMs,
        mode: request.context.mode,
        actor: request.context.actor,
        correlationId: request.context.correlationId,
      },
    });
  }

  /**
   * Extract tool names referenced in the execution input.
   */
  private extractToolNames(input: Record<string, unknown>): string[] {
    if (!input || typeof input !== 'object') return [];

    const tools: string[] = [];

    // Check for a standard "tools" array.
    const rawTools = input['tools'];
    if (Array.isArray(rawTools)) {
      for (const t of rawTools) {
        if (typeof t === 'string') tools.push(t);
        if (typeof t === 'object' && t !== null) {
          const name = (t as Record<string, unknown>)['name'] ?? (t as Record<string, unknown>)['tool'];
          if (typeof name === 'string') tools.push(name);
        }
      }
    }

    // Check for a single "tool" field.
    const singleTool = input['tool'];
    if (typeof singleTool === 'string') tools.push(singleTool);

    // Check for "toolCalls" array (agent-style format).
    const toolCalls = input['toolCalls'];
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (typeof tc === 'object' && tc !== null) {
          const name = (tc as Record<string, unknown>)['toolName'] ?? (tc as Record<string, unknown>)['name'];
          if (typeof name === 'string') tools.push(name);
        }
      }
    }

    return [...new Set(tools)];
  }

  private buildErrorResult(
    skillName: string,
    startTime: number,
    error: string,
  ): SkillExecutionResult {
    return {
      skillName,
      success: false,
      output: {},
      error,
      durationMs: Date.now() - startTime,
      auditEventId: uuidv4(),
    };
  }

  /**
   * Convert validated Zod output to a SkillManifest (workspace type).
   */
  private toSkillManifest(data: z.infer<typeof SkillJsonSchema>): SkillManifest {
    return {
      name: data.name,
      version: data.version,
      description: data.description,
      status: data.status as SkillStatus,
      allowedModes: data.allowedModes as RuntimeMode[],
      permissions: data.permissions as PermissionSet,
      toolsRequired: data.toolsRequired,
      inputs: data.inputs,
      outputs: data.outputs,
      riskLevel: data.riskLevel as RiskLevel,
      review: data.review as SkillReview,
      security: data.security as SkillSecurity,
    };
  }
}
