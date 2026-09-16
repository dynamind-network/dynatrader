import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, ToolRegistry } from '@dyna/contracts';
import {
  CORE_PROFILES,
  PLUGIN_PROFILES,
  resolveAgentProfiles,
  getToolsForProfiles,
} from '../tool-profiles';
import type { ToolProfile } from '../tool-profiles';
import type { AgentRegistry, ResolvedManifest } from '../../subagents';

/**
 * Minimal interface for the SubagentRuntime that SpawnSubagentTool depends on.
 * This avoids a hard dependency on the @dyna/subagent-runtime package
 * which has pre-existing compilation issues in this monorepo.
 */
export interface SpawnSubagentRuntimeLike {
  executeAgent(
    agentName: string,
    mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live',
    input: unknown,
  ): Promise<{
    agentName: string;
    mode: string;
    permissions: {
      allowedTools: string[];
      allowedSkills: string[];
      memoryAccess: { read: string[]; write: string[] };
    };
  }>;
  initialize?(workspacePath: string): Promise<void>;
  validateOutput?(agentName: string, output: unknown): Promise<{ valid: boolean; reasons: string[] }>;
  completeExecution?(agentName: string, output: unknown, executionTime: number): Promise<void>;
}

/**
 * SpawnSubagentTool - Hermes/OpenClaw-style subagent spawning
 *
 * Supports two modes:
 * 1. Named agent: Spawn a pre-configured agent from agents/*.md or profiles.yaml
 * 2. Ephemeral agent: Spawn a temporary agent with custom goal/context instructions
 *
 * Tool scoping:
 * - Named agents: profiles resolved from manifest → restricted tool set
 * - Ephemeral agents: base + memory profiles (safe default)
 * - Core profiles always included; plugin profiles only if plugins loaded
 */
export class SpawnSubagentTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'spawn_subagent',
    description: `Spawn a subagent session. Can spawn either:
- A named agent (from agents/*.md or profiles.yaml) by providing agentName
- An ephemeral agent with custom instructions by providing goal and context`,
    category: 'session',
    inputSchema: {
      // Named agent parameters
      agentName: 'string?',
      // Ephemeral agent parameters
      goal: 'string?',
      context: 'string?',
      // Common parameters
      mode: { type: 'string', enum: ['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'] },
      input: 'object?',
    },
    outputSchema: {
      session: 'object',
      agentName: 'string',
      mode: 'string',
      goal: 'string?',
    },
    permissionsRequired: ['session.spawn'],
    sideEffects: ['spawns_agent'],
    riskLevel: 'medium',
    timeoutMs: 30000,
  };

  constructor(
    private subagentRuntime: SpawnSubagentRuntimeLike,
    private toolRegistry?: ToolRegistry,
    private agentRegistry?: AgentRegistry,
    private loadedPluginProfiles?: ToolProfile[],
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const agentName = call.args.agentName as string | undefined;
      const goal = call.args.goal as string | undefined;
      const context = call.args.context as string | undefined;
      const mode = (call.args.mode as string | undefined) ?? 'research';
      const input = call.args.input ?? {};

      // Validate mode
      const validModes = ['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'] as const;
      if (!validModes.includes(mode as typeof validModes[number])) {
        return {
          success: false,
          error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Must have either agentName or goal
      if (!agentName && !goal) {
        return {
          success: false,
          error: 'Must provide either agentName (for named agent) or goal (for ephemeral agent)',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Determine agent name and resolve profiles
      let finalAgentName: string;
      let isEphemeral = false;
      let agentManifest: ResolvedManifest | undefined;
      let activeProfiles: ToolProfile[];

      if (agentName) {
        // Named agent mode — resolve from registry
        finalAgentName = agentName;
        if (this.agentRegistry) {
          agentManifest = await this.agentRegistry.find(agentName);
        }
        if (agentManifest) {
          activeProfiles = resolveAgentProfiles(
            agentManifest.profiles,
            this.loadedPluginProfiles,
          );
        } else {
          // Fallback: agent not in registry, use base profiles
          activeProfiles = [CORE_PROFILES.BASE, CORE_PROFILES.MEMORY];
        }
      } else {
        // Ephemeral agent mode — safe default profiles
        finalAgentName = `ephemeral-${Date.now()}`;
        isEphemeral = true;
        activeProfiles = [CORE_PROFILES.BASE, CORE_PROFILES.MEMORY];
      }

      // Build restricted tool set from profiles
      const profiledToolNames = getToolsForProfiles(activeProfiles);

      // Sandbox enforcement: if manifest declares sandbox config, apply it
      let sandboxConfig: { mode: string; scope: string } | undefined;
      if (agentManifest?.sandbox) {
        sandboxConfig = agentManifest.sandbox;
      }

      // Build input with goal and context for ephemeral agents
      const shouldAttachScope = isEphemeral || Boolean(agentManifest?.tools || agentManifest?.profiles || sandboxConfig);
      const scopedInput = shouldAttachScope ? {
        _scopedTools: profiledToolNames,
        _activeProfiles: activeProfiles,
      } : {};
      const agentInput = isEphemeral
        ? {
            ...input,
            goal,
            context,
            isEphemeral: true,
            ...scopedInput,
          }
        : {
            ...input,
            ...scopedInput,
            ...(sandboxConfig ? { _sandbox: sandboxConfig } : {}),
          };

      // Execute the agent
      const result = await this.subagentRuntime.executeAgent(
        finalAgentName,
        mode as 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live',
        agentInput,
      );

      return {
        success: true,
        data: {
          agentName: result.agentName,
          mode: result.mode,
          permissions: result.permissions,
          startedAt: new Date().toISOString(),
          goal,
          isEphemeral,
          profiles: activeProfiles,
          scopedTools: profiledToolNames,
          sandbox: sandboxConfig ?? null,
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}
