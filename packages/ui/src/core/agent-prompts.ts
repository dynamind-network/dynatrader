import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './prompt-sections.js';
import type { AgentConfig, ToolDefinition } from './types.js';

export interface SessionSnapshotManager {
  getSnapshotText(): string;
}

export interface PromptBuilder {
  buildSystemPrompt(
    toolDefinitions: ToolDefinition[],
    sessionSnapshotText: string,
    config: AgentConfig
  ): Promise<string>;
  invalidateCache(): void;
  getCacheStats(): { cached: number; total: number };
}

export interface PromptBuilderOptions {
  config: AgentConfig;
  sessionManager: SessionSnapshotManager;
}

type CacheEntry = {
  prompt: string;
};

function formatToolDefinitions(toolDefinitions: ToolDefinition[]): string {
  if (toolDefinitions.length === 0) {
    return '';
  }

  const lines = toolDefinitions.map((tool) => `- ${tool.name}: ${tool.description}`);
  return [`## Available Tools`, ...lines].join('\n');
}

function formatMcpServers(config: AgentConfig): string {
  const mcpServers = (config as AgentConfig & { mcpServers?: Record<string, unknown> }).mcpServers;
  const serverNames = mcpServers ? Object.keys(mcpServers) : [];

  if (serverNames.length === 0) {
    return '## MCP Servers\nNo MCP servers configured.';
  }

  return `## MCP Servers\nConfigured: ${serverNames.join(', ')}`;
}

function createStaticPrompt(toolDefinitions: ToolDefinition[], config: AgentConfig): string {
  const parts: string[] = [
    'You are DynaMind, an AI-powered general-purpose coding and agent assistant.',
    'You can handle software development, analysis, research, planning, automation, and domain-specific workflows when the necessary tools or context are available.',
    '',
    '## Response Style',
    '- Be direct and concise',
    '- Use data from tools to support claims',
    '- Show code/file changes clearly',
    '- Use structured output for complex information',
    '- Prioritize safety and clear reasoning in all contexts',
    '',
    '## Tool Guidance',
    '- Use the tool that best matches the task',
    '- Do not describe what you will do; use tools directly',
    '- Prefer a direct tool call over narrative when a tool can answer the question',
  ];

  const toolsSection = formatToolDefinitions(toolDefinitions);
  if (toolsSection) {
    parts.push('', toolsSection);
  }

  if (config.systemPrompt?.trim()) {
    parts.push('', config.systemPrompt.trim());
  }

  parts.push('', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, '', formatMcpServers(config));

  return parts.join('\n');
}

export class AgentPromptBuilder implements PromptBuilder {
  private cache = new Map<string, CacheEntry>();

  constructor(private options: PromptBuilderOptions) {}

  async buildSystemPrompt(
    toolDefinitions: ToolDefinition[],
    sessionSnapshotText: string,
    config: AgentConfig
  ): Promise<string> {
    const cacheKey = JSON.stringify({
      systemPrompt: config.systemPrompt ?? '',
      tools: toolDefinitions.map((tool) => [tool.name, tool.description]),
      mcpServers: Object.keys(
        (config as AgentConfig & { mcpServers?: Record<string, unknown> }).mcpServers ?? {}
      ),
    });

    let staticPrompt = this.cache.get(cacheKey)?.prompt;
    if (!staticPrompt) {
      staticPrompt = createStaticPrompt(toolDefinitions, config);
      this.cache.set(cacheKey, { prompt: staticPrompt });
    }

    return [
      staticPrompt,
      '',
      '## Current Session Context',
      sessionSnapshotText?.trim() ||
        this.options.sessionManager.getSnapshotText() ||
        'No prior session summary available.',
    ].join('\n');
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { cached: number; total: number } {
    return {
      cached: this.cache.size,
      total: this.cache.size,
    };
  }
}

export function createPromptBuilder(options: PromptBuilderOptions): PromptBuilder {
  return new AgentPromptBuilder(options);
}

