import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPromptBuilder,
  type PromptBuilder,
  type SessionSnapshotManager,
} from '../src/core/agent-prompts.js';
import type { AgentConfig, ToolDefinition } from '../src/core/types.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/core/prompt-sections.js';

function tool(name: string, description: string): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

function createMockSessionManager(snapshotText = 'No prior session summary available.'): SessionSnapshotManager {
  return {
    getSnapshotText: () => snapshotText,
  };
}

function createMockConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Custom system prompt from config.',
    maxTokens: 4096,
    maxTurns: 20,
    tools: ['read', 'write', 'shell'],
    temperature: 0.7,
    ...overrides,
  };
}

describe('createPromptBuilder', () => {
  let builder: PromptBuilder;
  let config: AgentConfig;
  let sessionManager: SessionSnapshotManager;

  beforeEach(() => {
    config = createMockConfig();
    sessionManager = createMockSessionManager();
    builder = createPromptBuilder({ config, sessionManager });
  });

  describe('buildSystemPrompt', () => {
    it('should build a system prompt with all sections', async () => {
      const toolDefinitions = [
        tool('read', 'Read a file'),
        tool('write', 'Write to a file'),
      ];

      const result = await builder.buildSystemPrompt(
        toolDefinitions,
        'Session snapshot text',
        config
      );

      expect(result).toContain('You are DynaMind');
      expect(result).toContain('## Available Tools');
      expect(result).toContain('- read: Read a file');
      expect(result).toContain('- write: Write to a file');
      expect(result).toContain('## Response Style');
      expect(result).toContain('Custom system prompt from config.');
      expect(result).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      expect(result).toContain('## Current Session Context');
      expect(result).toContain('Session snapshot text');
      expect(result).toContain('## MCP Servers');
    });

    it('should handle empty tool definitions', async () => {
      const result = await builder.buildSystemPrompt([], 'Session snapshot', config);

      expect(result).toContain('You are DynaMind');
      expect(result).not.toContain('## Available Tools');
      expect(result).toContain('## Response Style');
    });

    it('should include custom system prompt from config', async () => {
      const customConfig = createMockConfig({
        systemPrompt: 'My custom prompt here.',
      });
      const customBuilder = createPromptBuilder({ config: customConfig, sessionManager });

      const result = await customBuilder.buildSystemPrompt([], 'snapshot', customConfig);

      expect(result).toContain('My custom prompt here.');
    });

    it('should handle missing custom system prompt', async () => {
      const noPromptConfig = createMockConfig({ systemPrompt: '' });
      const noPromptBuilder = createPromptBuilder({ config: noPromptConfig, sessionManager });

      const result = await noPromptBuilder.buildSystemPrompt([], 'snapshot', noPromptConfig);

      expect(result).toContain('You are DynaMind');
    });

    it('should include session context section', async () => {
      const sessionText = 'Recent goals: Analyze BTC price';
      const result = await builder.buildSystemPrompt([], sessionText, config);

      expect(result).toContain('## Current Session Context');
      expect(result).toContain(sessionText);
    });

    it('should include MCP section with no servers', async () => {
      const result = await builder.buildSystemPrompt([], 'snapshot', config);

      expect(result).toContain('## MCP Servers');
      expect(result).toContain('No MCP servers configured.');
    });

    it('should include MCP section with configured servers', async () => {
      const configWithMcp = createMockConfig();
      (configWithMcp as AgentConfig & { mcpServers?: Record<string, unknown> }).mcpServers = {
        github: { url: 'https://github.com' },
        slack: { url: 'https://slack.com' },
      };
      const mcpBuilder = createPromptBuilder({ config: configWithMcp, sessionManager });

      const result = await mcpBuilder.buildSystemPrompt([], 'snapshot', configWithMcp);

      expect(result).toContain('## MCP Servers');
      expect(result).toContain('Configured: github, slack');
    });

    it('should separate sections with double newlines', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];
      const result = await builder.buildSystemPrompt(toolDefinitions, 'snapshot', config);

      expect(result).toContain('\n\n');
    });

    it('should place dynamic boundary between static and dynamic sections', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];
      const result = await builder.buildSystemPrompt(toolDefinitions, 'snapshot', config);

      const boundaryIndex = result.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      const sessionIndex = result.indexOf('## Current Session Context');

      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(sessionIndex).toBeGreaterThan(boundaryIndex);
    });

    it('should cache static sections but not dynamic ones', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];

      const result1 = await builder.buildSystemPrompt(toolDefinitions, 'snapshot1', config);
      const result2 = await builder.buildSystemPrompt(toolDefinitions, 'snapshot2', config);

      expect(result1).toContain('You are DynaMind');
      expect(result2).toContain('You are DynaMind');
      expect(result1).toContain('snapshot1');
      expect(result2).toContain('snapshot2');
    });

    it('should handle single and many tool definitions', async () => {
      const single = await builder.buildSystemPrompt(
        [tool('shell', 'Execute shell commands')],
        'snapshot',
        config
      );
      expect(single).toContain('- shell: Execute shell commands');

      const many = await builder.buildSystemPrompt(
        [
          tool('read', 'Read files'),
          tool('write', 'Write files'),
        ],
        'snapshot',
        config
      );
      expect(many).toContain('- read: Read files');
      expect(many).toContain('- write: Write files');
    });
  });

  describe('session snapshot fallback', () => {
    it('uses the provided snapshot text directly without calling the manager', async () => {
      const getSnapshotText = vi.fn(() => 'manager text');
      const manager = createPromptBuilder({
        config,
        sessionManager: { getSnapshotText },
      });

      const result = await manager.buildSystemPrompt([], 'explicit text', config);
      expect(result).toContain('explicit text');
      expect(getSnapshotText).not.toHaveBeenCalled();
    });

    it('falls back to the session manager snapshot when the text is empty', async () => {
      const manager = createPromptBuilder({
        config,
        sessionManager: createMockSessionManager('manager snapshot'),
      });

      const result = await manager.buildSystemPrompt([], '', config);
      expect(result).toContain('manager snapshot');
    });

    it('falls back to the session manager snapshot for whitespace text', async () => {
      const manager = createPromptBuilder({
        config,
        sessionManager: createMockSessionManager('whitespace fallback'),
      });

      const result = await manager.buildSystemPrompt([], '   ', config);
      expect(result).toContain('whitespace fallback');
    });

    it('uses the default message when both text and manager snapshot are empty', async () => {
      const manager = createPromptBuilder({
        config,
        sessionManager: createMockSessionManager(''),
      });

      const result = await manager.buildSystemPrompt([], '', config);
      expect(result).toContain('No prior session summary available.');
    });
  });

  describe('invalidateCache', () => {
    it('should reset cache stats after invalidation', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];

      await builder.buildSystemPrompt(toolDefinitions, 'snapshot', config);

      const statsBefore = builder.getCacheStats();
      expect(statsBefore.total).toBeGreaterThan(0);

      builder.invalidateCache();

      const statsAfter = builder.getCacheStats();
      expect(statsAfter.cached).toBe(0);
      expect(statsAfter.total).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return initial stats with zero values', () => {
      const stats = builder.getCacheStats();

      expect(stats.cached).toBe(0);
      expect(stats.total).toBe(0);
    });

    it('should reflect cached sections after building prompt', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];

      await builder.buildSystemPrompt(toolDefinitions, 'snapshot', config);

      const stats = builder.getCacheStats();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.cached).toBeGreaterThan(0);
    });
  });

  describe('section content verification', () => {
    it('intro section should mention DynaMind and stay general-purpose', async () => {
      const result = await builder.buildSystemPrompt([], 'snapshot', config);
      expect(result).toContain('DynaMind');
      expect(result).toContain('general-purpose coding and agent assistant');
      expect(result).not.toContain('cryptocurrency trading');
    });

    it('tone section should mention being direct and concise', async () => {
      const result = await builder.buildSystemPrompt([], 'snapshot', config);
      expect(result).toContain('direct and concise');
      expect(result).toContain('Use data from tools');
    });

    it('tools section should instruct to not describe actions', async () => {
      const toolDefinitions = [tool('read', 'Read a file')];
      const result = await builder.buildSystemPrompt(toolDefinitions, 'snapshot', config);
      expect(result).toContain('Do not describe what you will do');
      expect(result).toContain('best matches');
    });
  });
});