import { describe, expect, it } from 'vitest';
import { SpawnAgentTool, SubagentRegistry } from '../src/agents/index.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

describe('subagent presets', () => {
  it('starts without bundled presets', async () => {
    const subagentRegistry = new SubagentRegistry();

    await subagentRegistry.initialize();

    expect(subagentRegistry.getNames()).toEqual([]);
    expect(subagentRegistry.getVisible()).toEqual([]);
  });

  it('leaves the spawn_agent preset enum empty until presets are configured', async () => {
    const subagentRegistry = new SubagentRegistry();
    const tool = new SpawnAgentTool({
      apiKeys: { deepseek: 'test-key' },
      model: 'deepseek-chat',
      subagentRegistry,
      toolRegistry: new ToolRegistry(),
    });

    await tool.initialize();

    expect(tool.inputSchema.properties.preset.enum).toEqual([]);
    expect(tool.description).toContain('configured preset');

    const result = await tool.execute(
      {
        task: 'Investigate the issue',
      },
      {
        workingDirectory: process.cwd(),
        conversationId: 'test-conversation',
        isSubagent: false,
      }
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('no subagent presets are configured');
  });
});
