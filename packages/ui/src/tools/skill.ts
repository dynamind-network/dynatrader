import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext } from '../core/types.js';
import * as path from 'node:path';
import { SkillManager } from '../agents/skill-manager.js';
import { resolveTemplate, buildDefaultVariables } from '../utils/template-engine.js';
import { processShellBlocks } from '../utils/shell-executor.js';

interface InputSchema {
  type: 'object';
  properties: {
    skill_id: { type: 'string'; description: 'ID of the skill to invoke' };
    query: { type: 'string'; description: 'User query or input for the skill' };
  };
  required: ['skill_id', 'query'];
}

export class SkillTool extends BaseTool {
  name = 'invoke_skill';
  description = 'Invoke a user-defined skill by ID with a query';
  isDestructive = false;
  inputSchema: InputSchema = {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'ID of the skill to invoke' },
      query: {
        type: 'string',
        description: 'User query or input for the skill',
      },
    },
    required: ['skill_id', 'query'],
  };

  private skillManager: SkillManager;

  constructor(skillManager: SkillManager) {
    super();
    this.skillManager = skillManager;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<{ success: boolean; output: string }> {
    const skillId = input.skill_id as string;
    const query = (input.query as string) ?? '';

    const skill = this.skillManager.getSkill(skillId);
    if (!skill) {
      return this.error(`Skill not found: ${skillId}`);
    }
    if (!skill.enabled) {
      return this.error(`Skill ${skillId} is not activated`);
    }

    let result = await processShellBlocks(skill.body, {
      workingDir: context.workingDirectory,
    });

    const variables = buildDefaultVariables({
      SKILL_DIR: skill.filePath ? path.dirname(skill.filePath) : undefined,
      WORKING_DIR: context.workingDirectory,
      SESSION_ID: context.conversationId,
      QUERY: query,
    });
    result = resolveTemplate(result, variables);

    if (result.includes('{{query}}')) {
      result = result.replace(/{{\s*query\s*}}/g, query);
    }

    const meta: Record<string, unknown> = {};
    if (skill.model) {
      meta.model = skill.model;
    }
    if (skill.allowedTools.length > 0) {
      meta.allowedTools = skill.allowedTools;
    }

    return this.success(result);
  }
}

