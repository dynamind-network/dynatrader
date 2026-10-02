import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GlobTool } from './tools/glob-tool';
import { GrepTool } from './tools/grep-tool';

describe('read-only planning tools', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dyna-plan-tools-'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'agent.ts'), 'export class AgentCore {}\n');
    await writeFile(path.join(root, 'README.md'), '# project\n');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('globs repository files without leaving the allowed root', async () => {
    const tool = new GlobTool([root]);
    expect(tool.definition.readOnly).toBe(true);
    const result = await tool.execute({ tool: 'glob', args: { pattern: '**/*.ts', path: root } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ files: ['src/agent.ts'] });
    const denied = await tool.execute({ tool: 'glob', args: { pattern: '**/*', path: os.tmpdir() } });
    expect(denied.success).toBe(false);
  });

  it('returns line-oriented grep matches', async () => {
    const tool = new GrepTool([root]);
    expect(tool.definition.readOnly).toBe(true);
    const result = await tool.execute({ tool: 'grep', args: { pattern: 'AgentCore', path: root } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ matches: [{ path: 'src/agent.ts', line: 1, text: 'export class AgentCore {}' }] });
  });
});
