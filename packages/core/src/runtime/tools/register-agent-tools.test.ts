import { describe, expect, it } from 'vitest';
import { ToolRegistryImpl } from './tool-registry';
import { registerAgentTools } from './register-agent-tools';
import { getRegisteredToolsForProfiles } from './tool-profiles';

describe('shared agent tool registration', () => {
  it('shares common constructors while keeping stdio read-only', () => {
    const runtime = new ToolRegistryImpl();
    const stdio = new ToolRegistryImpl();
    const memory = {} as ConstructorParameters<typeof import('./tools/memory-search-tool').MemorySearchTool>[0];
    const backend = {} as ConstructorParameters<typeof import('./tools/memory-write-tool').MemoryWriteTool>[0];
    const common = {
      projectRoot: 'C:/project',
      workspaceRoot: 'C:/workspace',
      allowedDirectories: ['C:/project', 'C:/workspace'] as string[],
      memoryStore: memory,
      memoryBackend: backend,
      filesystem: true,
      mutations: true,
      execution: true,
      web: true,
      sessionSearch: true,
    };

    registerAgentTools(runtime, { ...common, host: 'runtime' });
    registerAgentTools(stdio, {
      ...common,
      host: 'stdio',
      mutations: false,
      execution: false,
    });

    const runtimeNames = new Set(runtime.list().map((tool) => tool.definition.name));
    const stdioNames = new Set(stdio.list().map((tool) => tool.definition.name));
    expect([...stdioNames].every((name) => runtimeNames.has(name))).toBe(true);
    expect(stdioNames).toContain('read');
    expect(stdioNames).toContain('memory_search');
    expect(stdioNames).toContain('session_search');
    expect(stdioNames).not.toContain('memory_write');
    expect(stdioNames).not.toContain('write');
    expect(stdioNames).not.toContain('edit');
    expect(stdioNames).not.toContain('exec');
    expect(runtime.get('read')?.definition.readOnly).toBe(true);
    expect(runtime.get('exec')).toBeDefined();
    expect(runtime.get('session_search')).toBeDefined();
  });

  it('builds the visible profile catalog from handlers that are actually registered', () => {
    const registry = new ToolRegistryImpl();
    registerAgentTools(registry, {
      host: 'stdio', projectRoot: 'C:/project', workspaceRoot: 'C:/workspace',
      allowedDirectories: ['C:/project', 'C:/workspace'],
      filesystem: true, mutations: false, execution: false, web: true,
    });

    const visible = getRegisteredToolsForProfiles(registry, ['base']);
    expect(visible).toContain('read');
    expect(visible).toContain('web_search');
    expect(visible).not.toContain('exec');
    expect(visible).not.toContain('memory_search');
    expect(visible).not.toContain('write');
  });
});
