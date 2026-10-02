import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ReadAgentResultTool, ListAgentResultsTool } from '../src/tools/subagent-result.js';

describe('subagent results tools', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reads results from an absolute trusted directory outside the workspace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamind-agent-results-'));
    const taskId = 'task-123';
    await fs.writeFile(
      path.join(tempDir, `${taskId}.json`),
      JSON.stringify({
        taskId,
        presetName: 'task',
        status: 'completed',
        result: 'done',
        error: null,
        completedAt: new Date().toISOString(),
      })
    );

    const tool = new ReadAgentResultTool(tempDir);
    const result = await tool.execute(
      { task_id: taskId },
      {
        workingDirectory: path.join(tempDir, 'workspace'),
        conversationId: 'conv',
        isSubagent: false,
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('done');
  });

  it('lists results from an absolute trusted directory outside the workspace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamind-agent-results-'));
    await fs.writeFile(
      path.join(tempDir, 'task-abc.json'),
      JSON.stringify({
        taskId: 'task-abc',
        presetName: 'general',
        status: 'completed',
        result: 'ok',
        error: null,
        completedAt: new Date().toISOString(),
      })
    );

    const tool = new ListAgentResultsTool(tempDir);
    const result = await tool.execute(
      {},
      {
        workingDirectory: path.join(tempDir, 'workspace'),
        conversationId: 'conv',
        isSubagent: false,
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('task-abc');
    expect(result.output).toContain('general');
  });
});
