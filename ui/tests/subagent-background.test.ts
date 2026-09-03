import { mkdtemp, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpawnAgentTool, SubagentRegistry } from '../src/agents/subagent.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

describe('Subagent background execution', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('writes background results to .dynamind/agent-results by default', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'dynamind-subagent-'));
    tmpDirs.push(workingDirectory);
    const registry = new SubagentRegistry();
    registry.register({
      name: 'test-agent',
      description: 'test',
      systemPrompt: 'test',
      tools: [],
      maxTurns: 1,
      canSpawnSubagents: false,
    });

    const tool = new SpawnAgentTool({
      apiKeys: { anthropic: 'test-key' },
      model: 'deepseek-chat',
      subagentRegistry: registry,
      toolRegistry: new ToolRegistry(),
    });

    await tool.initialize();
    vi.spyOn(tool as any, 'executeSubagent').mockResolvedValue('background done');

    const result = await tool.execute(
      {
        preset: 'test-agent',
        task: 'do work',
        execution_mode: 'async',
      },
      {
        workingDirectory,
        conversationId: 'test',
        isSubagent: false,
      }
    );

    expect(result.success).toBe(true);
    const taskId = result.output.match(/Task ID: ([^\n]+)/)?.[1];
    expect(taskId).toBeTruthy();

    // Poll for the background result file to be written
    const resultPath = path.join(workingDirectory, '.dynamind', 'agent-results', `${taskId}.json`);

    const maxAttempts = 20;
    let fileContent: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fileContent = await readFile(resultPath, 'utf-8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    expect(fileContent).toBeDefined();
    expect(fileContent!).toContain('"status": "completed"');
    expect(fileContent!).toContain('"result": "background done"');
    expect(fileContent!).toContain('"presetName": "test-agent"');
  });
});
