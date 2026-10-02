import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';
import type { SkillLoader } from './skill-loader';

/** Lists only skills already loaded from explicitly registered SkillLoader roots. */
export class SkillsListTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'skills_list',
    description: 'List skills available to this agent from its registered skill catalog. Returns names and descriptions only; use skill_view with an exact returned name to read instructions or a relative support file.',
    category: 'memory',
    inputSchema: {},
    outputSchema: { count: 'number', skills: 'array' },
    permissionsRequired: ['tool.read'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 10000,
    canRunInParallel: true,
    readOnly: true,
  };

  constructor(private readonly loader: SkillLoader) {}

  async execute(_call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    const skills = this.loader.getAllSkills()
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
      .map((skill) => ({
        name: skill.metadata.name,
        description: skill.metadata.description,
      }));

    return {
      success: true,
      data: { count: skills.length, skills },
      durationMs: Date.now() - started,
      truncated: false,
    };
  }
}
