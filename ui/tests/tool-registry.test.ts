import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { BaseTool } from '../src/tools/base-tool.js';

class DummyTool extends BaseTool {
  name = 'mystery_tool';
  description = 'A tool that does not match any category';
  inputSchema = {
    type: 'object' as const,
    properties: {},
    required: [],
  };
  isDestructive = false;

  async execute() {
    return { success: true, output: 'ok' };
  }
}

describe('ToolRegistry', () => {
  it('places uncategorized tools in the uncategorized bucket', () => {
    const registry = new ToolRegistry();
    registry.register(new DummyTool());

    const results = registry.getToolsByCategory('uncategorized');

    expect(results.map((entry) => entry.name)).toContain('mystery_tool');
    expect(registry.getToolsByCategory('general')).toHaveLength(0);
  });
});
