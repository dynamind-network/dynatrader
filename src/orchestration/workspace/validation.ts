import type { WorkspaceManifest, RuntimeConfig } from './types';
import { Logger } from './logger';

export class WorkspaceValidator {
  private logger = new Logger('WorkspaceValidator');

  validateManifest(manifest: WorkspaceManifest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const agents = manifest.agents ?? [];
    const skills = manifest.skills ?? [];
    const loops = manifest.loops ?? [];
    const tools = manifest.tools ?? [];
    const adapters = manifest.adapters ?? [];
    const policies = manifest.policies ?? [];

    // Check required fields
    if (!manifest.soul) errors.push('SOUL.md is required');
    if (!manifest.identity) errors.push('IDENTITY.md is required');
    if (!manifest.memory) errors.push('MEMORY.md is required');
    // Validate agents
    agents.forEach((agent, index) => {
      if (!agent.name) errors.push(`Agent ${index + 1}: name is required`);
      if (!agent.version) errors.push(`Agent ${index + 1}: version is required`);
      if (!agent.allowedModes || agent.allowedModes.length === 0) {
        errors.push(`Agent ${index + 1}: at least one allowed mode is required`);
      }
      if (!agent.riskLevel) errors.push(`Agent ${index + 1}: risk_level is required`);
    });

    // Validate skills
    skills.forEach((skill, index) => {
      if (!skill.name) errors.push(`Skill ${index + 1}: name is required`);
      if (!skill.version) errors.push(`Skill ${index + 1}: version is required`);
      if (!skill.status) errors.push(`Skill ${index + 1}: status is required`);
      if (!['draft', 'validated', 'sandboxed', 'backtested', 'paper_approved', 'shadow_eligible', 'micro_live_eligible', 'live_eligible', 'deprecated'].includes(skill.status)) {
        errors.push(`Skill ${index + 1}: invalid status`);
      }
    });

    // Validate loops
    loops.forEach((loop, index) => {
      if (!loop.id) errors.push(`Loop ${index + 1}: id is required`);
      if (!loop.name) errors.push(`Loop ${index + 1}: name is required`);
      if (!loop.schedule) errors.push(`Loop ${index + 1}: schedule is required`);
      if (!loop.prompt && !loop.command) {
        errors.push(`Loop ${index + 1}: either prompt or command is required`);
      }
      if (loop.pipeline && !['analysis', 'execution', 'monitoring', 'research'].includes(loop.pipeline)) {
        errors.push(`Loop ${index + 1}: invalid pipeline`);
      }
      if (loop.approvalStatus && !['pending', 'approved', 'rejected'].includes(loop.approvalStatus)) {
        errors.push(`Loop ${index + 1}: invalid approval status`);
      }
      if (loop.executionPolicy && !['trade', 'close-only'].includes(loop.executionPolicy)) {
        errors.push(`Loop ${index + 1}: invalid execution policy`);
      }
    });

    // Validate tools
    tools.forEach((tool, index) => {
      if (!tool.name) errors.push(`Tool ${index + 1}: name is required`);
      if (!tool.version) errors.push(`Tool ${index + 1}: version is required`);
      if (!tool.adapter) errors.push(`Tool ${index + 1}: adapter is required`);
      if (!tool.riskLevel) errors.push(`Tool ${index + 1}: risk_level is required`);
    });

    // Validate adapters
    adapters.forEach((adapter, index) => {
      if (!adapter.name) errors.push(`Adapter ${index + 1}: name is required`);
      if (!adapter.version) errors.push(`Adapter ${index + 1}: version is required`);
      if (!['execution', 'market_data', 'broker', 'memory', 'model'].includes(adapter.type)) {
        errors.push(`Adapter ${index + 1}: invalid type`);
      }
    });

    // Validate policies
    policies.forEach((policy, index) => {
      if (!policy.name) errors.push(`Policy ${index + 1}: name is required`);
      if (!policy.version) errors.push(`Policy ${index + 1}: version is required`);
      if (!policy.rules || policy.rules.length === 0) {
        errors.push(`Policy ${index + 1}: at least one rule is required`);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateAgainstMode(manifest: WorkspaceManifest, mode: RuntimeConfig['mode']): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check if mode is allowed by any agent
    const hasAgentForMode = (manifest.agents ?? []).some(agent =>
      agent.allowedModes.includes(mode)
    );

    if (!hasAgentForMode) {
      errors.push(`No agents support mode: ${mode}`);
    }

    // micro_live and live have additional requirements
    if (mode === 'micro_live' || mode === 'live') {
      const authConfig = manifest.auth;
      if (!authConfig || !authConfig.owner) {
        errors.push(`Auth configuration with owner is required for ${mode} mode`);
      }
      if (!authConfig || !authConfig.approval_required_for) {
        errors.push(`Approval configuration is required for ${mode} mode`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

enum SkillStatus {
  DRAFT = 'draft',
  VALIDATED = 'validated',
  SANDBOXED = 'sandboxed',
  BACKTESTED = 'backtested',
  PAPER_APPROVED = 'paper_approved',
  SHADOW_ELIGIBLE = 'shadow_eligible',
  MICRO_LIVE_ELIGIBLE = 'micro_live_eligible',
  LIVE_ELIGIBLE = 'live_eligible',
  DEPRECATED = 'deprecated'
}
