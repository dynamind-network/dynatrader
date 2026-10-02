import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandService } from '../src/services/CommandService.js';
import { SubagentRegistry } from '../src/agents/subagent.js';
import { createDefaultToolRegistry } from '../src/index.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('command service agent creation', () => {
  const cleanupTargets: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupTargets.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it('creates a markdown agent file and refreshes the registry', async () => {
    const projectDir = await makeTempDir('dynamind-command-agent-');
    cleanupTargets.push(projectDir);

    const registry = new SubagentRegistry({ projectDir, globalDir: undefined });
    await registry.initialize();

    let refreshed = false;
    const commandService = new CommandService({
      subagentRegistry: registry,
      toolRegistry: createDefaultToolRegistry(projectDir),
      cwd: projectDir,
      getConversationId: () => 'session-1',
      onMessage: () => {},
      onProcessingChange: () => {},
      onToolChange: () => {},
      onModelChange: () => {},
      onActiveToolsChange: () => {},
      onNavigate: () => {},
      onConnectProvider: () => {},
      onClearSession: () => {},
      onListSessions: async () => '',
      onResumeSession: async () => ({ success: true, message: '' }),
      onQuestionRequired: async () => null,
      onStartAgentCreate: () => {},
      onAuthChanged: async () => {},
      onSubagentsChanged: async () => {
        refreshed = true;
        await registry.initialize();
      },
      onShowSessionPicker: () => {},
      currentModel: 'test-model',
    });

    const result = await commandService.createCustomAgent({
      name: 'researcher',
      description: 'Does research work',
      scope: 'project',
      tools: ['read_file'],
      maxTurns: 7,
      visible: true,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('researcher');
    expect(refreshed).toBe(true);

    const filePath = path.join(projectDir, 'researcher.md');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('name: researcher');
    expect(content).toContain('mode:');
    expect(content).toContain('subagent: true');
    expect(registry.get('researcher')).toBeDefined();
  });
});

describe('command service runtime tool catalog', () => {
  it('returns tools from the Core RPC agent loop rather than a local UI registry', async () => {
    const tools = [{ name: 'memory_search', description: 'Search memory', category: 'memory' }];
    const service = new CommandService({
      agentLoop: { listAvailableTools: async () => tools } as never,
      cwd: process.cwd(),
      getConversationId: () => 'session-1',
      onMessage: () => {},
      onProcessingChange: () => {},
      onToolChange: () => {},
      onModelChange: () => {},
      onActiveToolsChange: () => {},
      onNavigate: () => {},
      onConnectProvider: () => {},
      onClearSession: () => {},
      onListSessions: async () => '',
      onResumeSession: async () => ({ success: true, message: '' }),
      onQuestionRequired: async () => null,
      onStartAgentCreate: () => {},
      onAuthChanged: async () => {},
      onSubagentsChanged: async () => {},
      onShowSessionPicker: () => {},
      currentModel: 'test-model',
    });

    await expect(service.listAvailableTools()).resolves.toEqual(tools);
  });
});
