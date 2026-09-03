import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuid } from 'uuid';

import { ToolRegistryImpl } from './tool-registry';
import { ExecTool } from './tools/exec-tool';
import { ReadTool } from './tools/read-tool';
import { WriteTool } from './tools/write-tool';
import { EditTool } from './tools/edit-tool';
import { GlobTool } from './tools/glob-tool';
import { GrepTool } from './tools/grep-tool';
import { WebFetchTool } from './tools/web-fetch-tool';
import { BrowserTool } from './tools/browser-tool';
import type { ToolCall, ToolHandler, ToolDefinition, ToolResult } from '@dyna/contracts';
import { packText } from '../context-packager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = path.join(os.tmpdir(), `tools-runtime-test-${uuid()}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    tool: 'test',
    args: {},
    correlationId: uuid(),
    ...overrides,
  };
}

// A simple handler for testing the registry
class TestHandler implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'test',
    description: 'A test tool',
    category: 'exec',
    inputSchema: {},
    outputSchema: {},
    permissionsRequired: [],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 5000,
  };

  constructor(
    private response?: Partial<ToolResult>,
    private delayMs = 0,
  ) {}

  async execute(_call: ToolCall): Promise<ToolResult> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return {
      success: true,
      durationMs: 0,
      truncated: false,
      ...this.response,
    };
  }
}

// ---------------------------------------------------------------------------
// ToolRegistryImpl
// ---------------------------------------------------------------------------

describe('ToolRegistryImpl', () => {
  let registry: ToolRegistryImpl;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
  });

  it('should register and retrieve tools', () => {
    const handler = new TestHandler();
    registry.register(handler);
    expect(registry.get('test')).toBe(handler);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should list all tools', () => {
    const h1 = new TestHandler();
    const h2 = new TestHandler();
    // Override names to distinguish
    (h1.definition as any).name = 'tool-a';
    (h1.definition as any).category = 'exec';
    (h2.definition as any).name = 'tool-b';
    (h2.definition as any).category = 'file';

    registry.register(h1);
    registry.register(h2);

    const all = registry.list();
    expect(all).toHaveLength(2);
  });

  it('should list tools by category', () => {
    const h1 = new TestHandler();
    const h2 = new TestHandler();
    (h1.definition as any).name = 'exec-tool';
    (h1.definition as any).category = 'exec';
    (h2.definition as any).name = 'file-tool';
    (h2.definition as any).category = 'file';

    registry.register(h1);
    registry.register(h2);

    const execTools = registry.list('exec');
    expect(execTools).toHaveLength(1);
    expect(execTools[0]?.definition.name).toBe('exec-tool');

    const webTools = registry.list('web');
    expect(webTools).toHaveLength(0);
  });

  it('should execute a tool and return result', async () => {
    const handler = new TestHandler({ data: { message: 'hello' } });
    registry.register(handler);

    const result = await registry.execute(makeCall());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ message: 'hello' });
  });

  it('should handle unknown tool gracefully', async () => {
    const result = await registry.execute(makeCall({ tool: 'does-not-exist' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('should track execution duration', async () => {
    const handler = new TestHandler({}, 50);
    registry.register(handler);

    const result = await registry.execute(makeCall());
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('should enforce tool timeout', async () => {
    const handler = new TestHandler({}, 10000); // 10s delay
    // Override timeout on the definition
    (handler.definition as any).timeoutMs = 100;
    registry.register(handler);

    const result = await registry.execute(makeCall());
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should truncate large string data in result', async () => {
    const bigString = 'x'.repeat(200 * 1024); // 200KB
    const handler = new TestHandler({ data: bigString });
    registry.register(handler);

    const result = await registry.execute(makeCall());
    expect(result.truncated).toBe(true);
    expect(typeof result.data).toBe('string');
    expect((result.data as string).length).toBeLessThan(150 * 1024);
    expect((result.data as string)).toMatch(/\[truncated \d+ chars\]/);
  });

  it('should truncate large stdout in data object', async () => {
    const bigString = 'x'.repeat(200 * 1024); // 200KB
    const handler = new TestHandler({
      data: { stdout: bigString, stderr: '', exitCode: 0 },
    });
    registry.register(handler);

    const result = await registry.execute(makeCall());
    expect(result.truncated).toBe(true);
    expect((result.data as any).stdout).toMatch(/\[truncated \d+ chars\]/);
  });

  it('packs long text with both head and tail preserved', () => {
    const packed = packText(`begin-${'x'.repeat(500)}-finish`, 80, 20);
    expect(packed.truncated).toBe(true);
    expect(packed.text).toContain('begin');
    expect(packed.text).toContain('-finish');
    expect(packed.text).toMatch(/\[truncated \d+ chars\]/);
  });
});

// ---------------------------------------------------------------------------
// ExecTool
// ---------------------------------------------------------------------------

describe('ExecTool', () => {
  let tool: ExecTool;

  beforeEach(() => {
    tool = new ExecTool();
  });

  it('should execute allowed commands successfully', async () => {
    const isWin = process.platform === 'win32';
    const command = isWin ? 'echo hello' : 'echo hello';

    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command },
    }));

    expect(result.success).toBe(true);
    if (isWin) {
      expect(result.stdout).toContain('hello');
    } else {
      expect(result.stdout).toContain('hello');
    }
  });

  it('should block disallowed commands', async () => {
    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command: 'sudo ls' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('should block dangerous commands from blocklist', async () => {
    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command: 'docker ps' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('should block shell-wrapper command injection forms', async () => {
    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command: 'bash -c "echo hello"' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('should enforce execution timeout', async () => {
    const isWin = process.platform === 'win32';
    // Use a command that will hang
    const command = isWin
      ? 'ping -n 10 127.0.0.1'
      : 'sleep 10';

    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command, timeout: 500 },
    }));

    expect(result.success).toBe(false);
    // Should get a timeout or error
    expect(
      result.error?.includes('timeout') ||
      result.error?.includes('ETIMEDOUT') ||
      result.error?.includes('timed') ||
      !result.success
    ).toBe(true);
  });

  it('should reject empty command', async () => {
    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command: '' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should reject non-string command', async () => {
    const result = await tool.execute(makeCall({
      tool: 'exec',
      args: { command: 123 },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('string');
  });

  it('should capture stderr on failure', async () => {
    const command = 'git status --short';
    const failureTool = new ExecTool({
      defaultCwd: tmpDir,
      workspaceRoot: tmpDir,
    });

    const result = await failureTool.execute(makeCall({
      tool: 'exec',
      args: { command },
    }));

    expect(result.success).toBe(false);
    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
  });

  it('should work with custom allowlist', async () => {
    const restrictedTool = new ExecTool({
      allowlist: ['echo', 'git'],
    });

    const result = await restrictedTool.execute(makeCall({
      tool: 'exec',
      args: { command: 'echo test' },
    }));

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('test');
  });

  it('should block commands not in custom allowlist', async () => {
    const restrictedTool = new ExecTool({
      allowlist: ['echo', 'git'],
    });

    const result = await restrictedTool.execute(makeCall({
      tool: 'exec',
      args: { command: 'ls' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('should block workdir traversal outside the workspace root', async () => {
    const workspaceRoot = path.join(tmpDir, 'exec-workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });

    const boundedTool = new ExecTool({
      defaultCwd: workspaceRoot,
      workspaceRoot,
    });

    const result = await boundedTool.execute(makeCall({
      tool: 'exec',
      args: {
        command: 'echo hello',
        workdir: path.join(workspaceRoot, '..'),
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Workdir traversal blocked');
  });
});

// ---------------------------------------------------------------------------
// ReadTool
// ---------------------------------------------------------------------------

describe('ReadTool', () => {
  let tool: ReadTool;
  let testFilePath: string;

  beforeEach(async () => {
    tool = new ReadTool({ allowedDirectories: [tmpDir] });
    testFilePath = path.join(tmpDir, 'test-read.txt');
    await fs.writeFile(testFilePath, 'Hello, world!', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(testFilePath, { force: true });
  });

  it('should read existing files', async () => {
    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: testFilePath },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).content).toBe('Hello, world!');
    expect((result.data as any).mode).toBe('text');
  });

  it('should reject non-existent files', async () => {
    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: path.join(tmpDir, 'does-not-exist.txt') },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should block path traversal', async () => {
    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: '../outside.txt' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('should read in binary mode', async () => {
    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: testFilePath, mode: 'binary' },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe('binary');
    expect(typeof (result.data as any).content).toBe('string');
    // Base64 encoded "Hello, world!"
    expect((result.data as any).content).toBeDefined();
  });

  it('should handle empty string path', async () => {
    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: '' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should enforce max file size', async () => {
    const bigFile = path.join(tmpDir, 'big-file.txt');
    await fs.writeFile(bigFile, 'x'.repeat(100), 'utf-8');

    const result = await tool.execute(makeCall({
      tool: 'read',
      args: { path: bigFile, maxSize: 50 },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('should resolve relative paths against workspace root', async () => {
    const workspaceRoot = path.join(tmpDir, 'relative-workspace');
    await fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'note.txt'), 'relative hello', 'utf-8');
    const relativeTool = new ReadTool({
      allowedDirectories: [workspaceRoot],
      workspaceRoot,
    });

    const result = await relativeTool.execute(makeCall({
      tool: 'read',
      args: { path: 'docs/note.txt' },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).content).toBe('relative hello');
  });
});

// ---------------------------------------------------------------------------
// WriteTool
// ---------------------------------------------------------------------------

describe('WriteTool', () => {
  let tool: WriteTool;

  beforeEach(() => {
    tool = new WriteTool({ allowedDirectories: [tmpDir] });
  });

  it('should write files successfully', async () => {
    const filePath = path.join(tmpDir, 'test-write.txt');
    const result = await tool.execute(makeCall({
      tool: 'write',
      args: { path: filePath, content: 'written content' },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).path).toBe(filePath);
    expect((result.data as any).bytesWritten).toBeGreaterThan(0);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('written content');
  });

  it('should create parent directories automatically', async () => {
    const filePath = path.join(tmpDir, 'subdir', 'nested', 'test.txt');
    const result = await tool.execute(makeCall({
      tool: 'write',
      args: { path: filePath, content: 'nested file' },
    }));

    expect(result.success).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('nested file');

    // Cleanup
    await fs.rm(path.join(tmpDir, 'subdir'), { recursive: true, force: true });
  });

  it('should block path traversal', async () => {
    const result = await tool.execute(makeCall({
      tool: 'write',
      args: { path: '../../outside.txt', content: 'evil' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('should reject empty path', async () => {
    const result = await tool.execute(makeCall({
      tool: 'write',
      args: { path: '', content: 'test' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should resolve relative paths against workspace root', async () => {
    const workspaceRoot = path.join(tmpDir, 'write-workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    const relativeTool = new WriteTool({
      allowedDirectories: [workspaceRoot],
      workspaceRoot,
    });

    const result = await relativeTool.execute(makeCall({
      tool: 'write',
      args: { path: 'nested/output.txt', content: 'workspace relative write' },
    }));

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(workspaceRoot, 'nested', 'output.txt'), 'utf-8');
    expect(content).toBe('workspace relative write');
  });
});

// ---------------------------------------------------------------------------
// EditTool
// ---------------------------------------------------------------------------

describe('EditTool', () => {
  let tool: EditTool;
  let testFilePath: string;

  beforeEach(async () => {
    tool = new EditTool({ allowedDirectories: [tmpDir] });
    testFilePath = path.join(tmpDir, 'test-edit.txt');
    await fs.writeFile(testFilePath, 'Hello world, welcome to the world!', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(testFilePath, { force: true });
  });

  it('should replace text in files', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: testFilePath,
        oldString: 'Hello world',
        newString: 'Goodbye planet',
      },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).replacements).toBe(1);

    const content = await fs.readFile(testFilePath, 'utf-8');
    expect(content).toBe('Goodbye planet, welcome to the world!');
  });

  it('should handle file not found', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: path.join(tmpDir, 'nonexistent.txt'),
        oldString: 'foo',
        newString: 'bar',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should handle oldString not found', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: testFilePath,
        oldString: 'nonexistent text',
        newString: 'bar',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should require replaceAll for multiple matches', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: testFilePath,
        oldString: 'world',
        newString: 'planet',
        replaceAll: false,
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Found 2 matches');
    expect(result.error).toContain('replaceAll');
  });

  it('should support replaceAll mode', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: testFilePath,
        oldString: 'world',
        newString: 'planet',
        replaceAll: true,
      },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).replacements).toBe(2);

    const content = await fs.readFile(testFilePath, 'utf-8');
    expect(content).toBe('Hello planet, welcome to the planet!');
  });

  it('should block path traversal', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: '../../outside.txt',
        oldString: 'a',
        newString: 'b',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('should handle identical old and new strings', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: testFilePath,
        oldString: 'world',
        newString: 'world',
      },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).replacements).toBe(0);
  });

  it('should reject empty filePath', async () => {
    const result = await tool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: '',
        oldString: 'a',
        newString: 'b',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should resolve relative paths against workspace root', async () => {
    const workspaceRoot = path.join(tmpDir, 'edit-workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    const relativeFile = path.join(workspaceRoot, 'notes', 'agent.txt');
    await fs.mkdir(path.dirname(relativeFile), { recursive: true });
    await fs.writeFile(relativeFile, 'alpha beta gamma', 'utf-8');
    const relativeTool = new EditTool({
      allowedDirectories: [workspaceRoot],
      workspaceRoot,
    });

    const result = await relativeTool.execute(makeCall({
      tool: 'edit',
      args: {
        filePath: 'notes/agent.txt',
        oldString: 'beta',
        newString: 'delta',
      },
    }));

    expect(result.success).toBe(true);
    const content = await fs.readFile(relativeFile, 'utf-8');
    expect(content).toBe('alpha delta gamma');
  });
});

// ---------------------------------------------------------------------------
// GlobTool / GrepTool
// ---------------------------------------------------------------------------

describe('GlobTool and GrepTool', () => {
  let workspaceRoot: string;
  let globTool: GlobTool;
  let grepTool: GrepTool;

  beforeEach(async () => {
    workspaceRoot = path.join(tmpDir, 'search-workspace');
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'agent.ts'), 'export class AgentCore {}\n', 'utf-8');
    await fs.writeFile(path.join(workspaceRoot, 'src', 'notes.txt'), 'AgentCore appears here too\n', 'utf-8');
    globTool = new GlobTool([workspaceRoot], workspaceRoot);
    grepTool = new GrepTool([workspaceRoot], workspaceRoot);
  });

  it('should glob relative paths from workspace root', async () => {
    const result = await globTool.execute(makeCall({
      tool: 'glob',
      args: { pattern: '**/*.ts' },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).files).toContain('src/agent.ts');
  });

  it('should grep relative paths from workspace root', async () => {
    const result = await grepTool.execute(makeCall({
      tool: 'grep',
      args: { pattern: 'AgentCore' },
    }));

    expect(result.success).toBe(true);
    expect((result.data as any).matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/agent.ts' }),
        expect.objectContaining({ path: 'src/notes.txt' }),
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// WebFetchTool
// ---------------------------------------------------------------------------

describe('WebFetchTool', () => {
  let tool: WebFetchTool;

  beforeEach(() => {
    tool = new WebFetchTool({ defaultTimeout: 5000 });
  });

  it('should reject invalid URLs', async () => {
    const result = await tool.execute(makeCall({
      tool: 'web_fetch',
      args: { url: 'not-a-url' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('should reject unsupported protocols', async () => {
    const result = await tool.execute(makeCall({
      tool: 'web_fetch',
      args: { url: 'file:///etc/passwd' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported protocol');
  });

  it('should reject empty URL', async () => {
    const result = await tool.execute(makeCall({
      tool: 'web_fetch',
      args: { url: '' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should handle network errors gracefully', async () => {
    const result = await tool.execute(makeCall({
      tool: 'web_fetch',
      args: { url: 'http://localhost:1/', timeout: 2000 },
    }));

    // Should fail gracefully without throwing
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should timeout for slow servers', async () => {
    const result = await tool.execute(makeCall({
      tool: 'web_fetch',
      args: { url: 'http://10.255.255.1/', timeout: 500 },
    }));

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BrowserTool
// ---------------------------------------------------------------------------

describe('BrowserTool', () => {
  let tool: BrowserTool;

  beforeEach(() => {
    tool = new BrowserTool({ defaultTimeout: 5000 });
  });

  it('should reject invalid URLs', async () => {
    const result = await tool.execute(makeCall({
      tool: 'browser',
      args: { url: 'not-a-url' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('should reject empty URL', async () => {
    const result = await tool.execute(makeCall({
      tool: 'browser',
      args: { url: '' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should handle fetch failures gracefully', async () => {
    const result = await tool.execute(makeCall({
      tool: 'browser',
      args: { url: 'http://localhost:1/', timeout: 2000 },
    }));

    // Should fail gracefully
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
