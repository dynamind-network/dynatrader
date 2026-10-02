import { z } from 'zod';

export const AgentModeSchema = z
  .object({
    subagent: z.boolean().default(false),
    skill: z.boolean().default(false),
    command: z.boolean().default(false),
  })
  .strict();

export const SubAgentConfigSchema = z
  .object({
    model: z.string().default(''),
    maxTurns: z.number().optional(),
    temperature: z.number().optional(),
    canSpawnSubagents: z.boolean().default(false),
  })
  .strict();

export const AgentFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    hidden: z.boolean().optional(),
    mode: AgentModeSchema.optional(),
    agent: SubAgentConfigSchema.optional(),
    tools: z.array(z.string()).optional().default([]),
    mcp: z
      .object({
        prompts: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              parameters: z.record(z.unknown()).optional(),
            })
          )
          .optional(),
      })
      .optional(),
  })
  .strict();

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface LoadedAgent {
  id: string;
  filePath: string;
  scope: 'project' | 'global';
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  allowedTools: string[];
  filePath: string;
  enabled: boolean;
  scope: 'project' | 'global';
  paths?: string[];
  argumentHint?: string;
  model?: string;
}

export interface Command {
  id: string;
  name: string;
  description: string;
  body: string;
  model?: string;
  subtask?: boolean;
  filePath: string;
  enabled: boolean;
  scope: 'project' | 'global';
  argumentHint?: string;
}

