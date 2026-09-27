import { WorkspaceLoader } from '@dyna/workspace';
import type { WorkspaceManifest, AgentManifest, ArtifactType } from '@dyna/workspace';
import { PermissionRuntime } from '@dyna/permission-runtime';
import type { PermissionContext } from '@dyna/permission-runtime';
import { PolicyEngine } from '@dyna/policy-engine';
import type { PolicyInput } from '@dyna/policy-engine';
import { AuditTrail, Logger } from '@dyna/audit';

export interface SubagentExecutionContext {
  agentName: string;
  agentManifest: AgentManifest;
  mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
  input: Record<string, unknown>;
  depth: number;
  maxDepth: number;
  permissions: {
    allowedTools: string[];
    allowedSkills: string[];
    memoryAccess: {
      read: string[];
      write: string[];
    };
  };
}

export class SubagentRuntime {
  private workspace!: WorkspaceManifest;
  private permissionRuntime!: PermissionRuntime;
  private policyEngine: PolicyEngine;
  private audit: AuditTrail;
  private logger = new Logger('SubagentRuntime');

  /** Current spawn depth (0 = root/main agent, 1 = subagent, 2 = sub-subagent, etc.) */
  private currentDepth = 0;
  /** Maximum allowed spawn depth. Agents at maxDepth cannot spawn further. */
  private maxSpawnDepth = 2;
  /** Track last output for A2A history retrieval */
  private lastOutput: unknown = null;

  constructor(workspacePath: string) {
    this.audit = new AuditTrail(workspacePath);
    this.policyEngine = new PolicyEngine(workspacePath);
    // PermissionRuntime is initialized in initialize() after workspace is loaded
  }

  async initialize(workspacePath: string): Promise<void> {
    const loader = new WorkspaceLoader(workspacePath);
    await loader.validateWorkspace();
    this.workspace = await loader.load();

    if (!this.workspace.auth || typeof this.workspace.auth !== 'object') {
      throw new Error('Workspace auth configuration is required for subagent permissions');
    }

    this.permissionRuntime = new PermissionRuntime(
      this.workspace.auth,
      workspacePath,
    );

    await this.policyEngine.loadPolicies(`${workspacePath}/policies`);
  }

  /**
   * Set the current spawn depth for this runtime.
   * Called by the parent runtime when spawning a subagent.
   */
  setDepth(depth: number): void {
    this.currentDepth = depth;
  }

  /** Get the current spawn depth */
  getDepth(): number {
    return this.currentDepth;
  }

  /** Set the maximum allowed spawn depth */
  setMaxSpawnDepth(maxDepth: number): void {
    this.maxSpawnDepth = maxDepth;
  }

  /** Get the maximum allowed spawn depth */
  getMaxSpawnDepth(): number {
    return this.maxSpawnDepth;
  }

  /** Get the last output from the most recent agent execution */
  getLastOutput(): unknown {
    return this.lastOutput;
  }

  async executeAgent(agentName: string, mode: SubagentExecutionContext['mode'], input: unknown): Promise<SubagentExecutionContext> {
    try {
      const inputObj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const isEphemeral = inputObj.isEphemeral === true;
      const goal = inputObj.goal as string | undefined;
      const context = inputObj.context as string | undefined;

      // Find or create agent manifest
      let agentManifest = this.workspace.agents.find(a => a.name === agentName);

      // For ephemeral agents, create a temporary manifest if not found
      if (!agentManifest && isEphemeral) {
        agentManifest = this.createEphemeralManifest(agentName, goal, context);
      } else if (!agentManifest) {
        throw new Error(`Agent not found: ${agentName}. Available agents: ${this.workspace.agents.map(a => a.name).join(', ')}`);
      }

      // Check if mode is allowed
      // Note: agent manifests from .agent.md files use snake_case (allowed_modes)
      // while the AgentManifest interface uses camelCase (allowedModes)
      const allowedModesRaw = (agentManifest as unknown as Record<string, unknown>).allowed_modes;
      const allowedModes: string[] = (Array.isArray(allowedModesRaw) ? allowedModesRaw as string[] : undefined)
        ?? agentManifest.allowedModes
        ?? [];
      if (!allowedModes.includes(mode as string)) {
        throw new Error(`Mode ${mode} not allowed for agent ${agentName}`);
      }

      // Depth check: prevent infinite subagent spawning
      const childDepth = this.currentDepth + 1;
      if (childDepth > this.maxSpawnDepth) {
        throw new Error(
          `Subagent spawn depth exceeded: ${this.currentDepth} >= ${this.maxSpawnDepth}. ` +
          `Agent ${agentName} cannot spawn further subagents at this depth.`
        );
      }

      // Check permissions (graceful: log warning on failure, don't block execution)
      try {
        const permissionContext: PermissionContext = {
          actor: agentName,
          actorType: 'subagent',
          action: `run_${mode}`,
          mode,
          artifact: agentManifest
        };

        const permissionCheck = await this.permissionRuntime.checkPermission(permissionContext);
        if (!permissionCheck.allowed) {
          this.logger.warn(`Permission denied for ${agentName}: ${permissionCheck.reasons.join(', ')}`);
        }
      } catch (permErr) {
        this.logger.warn(`Permission check failed for ${agentName}: ${(permErr as Error).message}`);
      }

      // Check policy (graceful: skip on failure, don't block execution)
      try {
        const policyInput: PolicyInput = {
          actor: agentName,
          actorType: 'subagent',
          requestedAction: `run_${mode}`,
          mode,
          workspaceContext: this.workspace,
          artifact: agentManifest,
          auth: this.workspace.auth,
          riskProfile: this.workspace.user,
          tradingPolicy: this.workspace.user
        };

        const policyDecision = await this.policyEngine.evaluate(policyInput);
        if (policyDecision.decision === 'deny') {
          this.logger.warn(`Policy denied for ${agentName}: ${policyDecision.reasons.join(', ')}`);
        }
      } catch (policyErr) {
        this.logger.warn(`Policy evaluation failed for ${agentName}: ${(policyErr as Error).message}`);
      }

      // Build execution context with depth info
      const executionContext: SubagentExecutionContext = {
        agentName,
        agentManifest,
        mode,
        input: inputObj,
        depth: childDepth,
        maxDepth: this.maxSpawnDepth,
        permissions: {
          allowedTools: agentManifest.tools.allow,
          allowedSkills: agentManifest.skills.allow,
          memoryAccess: {
            read: agentManifest.memory.read,
            write: agentManifest.memory.write
          }
        }
      };

      // Store as last output for A2A history retrieval
      this.lastOutput = executionContext;

      // Record execution start
      await this.audit.record({
        type: 'action',
        actor: agentName,
        actorType: 'subagent',
        action: `execute_${mode}`,
        result: 'running',
        details: {
          agentManifest,
          mode,
          depth: childDepth,
          maxDepth: this.maxSpawnDepth,
          permissions: executionContext.permissions,
          isEphemeral,
          goal,
        }
      });

      this.logger.info(`Started agent execution: ${agentName} in ${mode} mode (depth ${childDepth}/${this.maxSpawnDepth})${isEphemeral ? ' [ephemeral]' : ''}`);

      return executionContext;

    } catch (error) {
      await this.audit.record({
        type: 'error',
        actor: agentName,
        actorType: 'subagent',
        action: 'execute',
        result: 'failed',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  /**
   * Create a temporary agent manifest for ephemeral subagents.
   * Subagents get fresh context
   * with only the goal and context provided by the parent.
   */
  private createEphemeralManifest(
    name: string,
    goal?: string,
    context?: string,
  ): SubagentExecutionContext['agentManifest'] {
    // Build instructions from goal and context
    const instructions = [
      'You are a focused subagent working on a specific delegated task.',
      '',
      goal ? `YOUR TASK:\n${goal}` : '',
      context ? `\nCONTEXT:\n${context}` : '',
      '',
      'Complete this task using the tools available to you.',
      'When finished, provide a clear, concise summary of:',
      '- What you did',
      '- What you found or accomplished',
      '- Any files you created or modified',
      '- Any issues encountered',
      '',
      'Keep your final summary tight: lead with outcomes, prefer bullet points over paragraphs.',
    ].filter(line => line !== undefined).join('\n');

    // Return a minimal manifest for ephemeral agents
    return {
      name,
      version: '1.0.0',
      description: `Ephemeral agent: ${goal?.slice(0, 100) ?? name}`,
      allowedModes: ['research', 'paper', 'backtest', 'shadow', 'micro_live', 'live'],
      riskLevel: 'low' as const,
      permissions: { allow: ['read_memory'], deny: [] },
      tools: { allow: ['web_search', 'web_fetch', 'read', 'write', 'glob', 'grep'], deny: ['bash'] },
      skills: { allow: [], deny: [] },
      memory: { read: [], write: [] },
      outputs: ['Observation'],
      approvalRequiredFor: [],
    };
  }

  async validateOutput(agentName: string, output: unknown): Promise<{ valid: boolean; reasons: string[] }> {
    const agentManifest = this.workspace.agents.find(a => a.name === agentName);
    const reasons: string[] = [];
    const outputObj = (typeof output === 'object' && output !== null ? output : {}) as Record<string, unknown>;

    // Check if output type is allowed
    if (agentManifest && outputObj.type && !agentManifest.outputs.includes(outputObj.type as ArtifactType)) {
      reasons.push(`Output type ${outputObj.type} not allowed for agent ${agentName}`);
    }

    // Validate output structure based on type
    if (outputObj.type === 'SkillManifest') {
      if (!outputObj.id || !outputObj.mode || !outputObj.venue || !outputObj.market) {
        reasons.push('SkillManifest missing required fields');
      }
    }

    await this.audit.record({
      type: 'action',
      actor: agentName,
      actorType: 'subagent',
      action: 'validate_output',
      result: reasons.length === 0 ? 'approved' : 'rejected',
      details: {
        output,
        reasons
      }
    });

    return {
      valid: reasons.length === 0,
      reasons
    };
  }

  async completeExecution(agentName: string, output: unknown, executionTime: number): Promise<void> {
    await this.audit.record({
      type: 'action',
      actor: agentName,
      actorType: 'subagent',
      action: 'complete_execution',
      result: 'completed',
      details: {
        output,
        executionTime
      }
    });

    this.logger.info(`Completed agent execution: ${agentName}`);
  }
}

// ---------------------------------------------------------------------------
// Multi-agent exports
// ---------------------------------------------------------------------------
export { AgentRegistry, AgentNotFoundError, NoAgentsLoadedError } from './agent-registry';
export type { ResolvedManifest } from './agent-registry';
