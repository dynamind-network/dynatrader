import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandRouter, CommandNotFoundError, PermissionDeniedError, ValidationError } from './command-router';
import type { CommandContext, CommandResult, CommandHandler } from './command-router';
import fs from 'fs/promises';
import path from 'path';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cmd-router-test-'));
  // Create workspace/auth.json
  const authDir = path.join(dir);
  writeFileSync(
    path.join(authDir, 'auth.json'),
    JSON.stringify({
      version: '1.0',
      owner: { id: 'operator', role: 'owner' },
      channels: {
        cli: { enabled: true, allowed_users: ['operator'] },
        web: { enabled: true, allowed_users: ['operator'] },
      },
      roles: {
        owner: { permissions: ['*'] },
        operator: { permissions: ['read_status', 'run_backtest', 'read_memory', 'write_memory'] },
      },
      approval_required_for: ['modify_risk_profile'],
      blocked_operations: ['withdraw_funds'],
    }),
    'utf-8',
  );
  return dir;
}

function createCommandManifest(workspaceDir: string, filename: string, manifest: Record<string, unknown>): string {
  const commandsDir = path.join(workspaceDir, 'commands');
  if (!existsSync(commandsDir)) {
    require('fs').mkdirSync(commandsDir, { recursive: true });
  }
  const filePath = path.join(commandsDir, filename);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
  return filePath;
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    actor: 'operator',
    actorType: 'user',
    args: {},
    mode: 'research',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandRouter', () => {
  let workspaceDir: string;
  let router: CommandRouter;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    router = new CommandRouter({ workspacePath: workspaceDir });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Discovery
  // -----------------------------------------------------------------------

  it('should discover command manifests from workspace/commands/*.command.json', async () => {
    createCommandManifest(workspaceDir, 'status.command.json', {
      name: 'runtime.status',
      description: 'Get runtime status',
      aliases: ['/status', 'status'],
      permissions: ['read_status'],
      sideEffects: { readsMarketData: false, writesMemory: false },
    });

    const manifests = await router.discoverCommands();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.name).toBe('runtime.status');
    expect(manifests[0]!.aliases).toEqual(['/status', 'status']);
    expect(manifests[0]!.permissions).toEqual(['read_status']);
  });

  it('should return empty array when no commands directory exists', async () => {
    // Remove the commands dir that may have been created
    const manifests = await router.discoverCommands();
    expect(manifests).toEqual([]);
  });

  it('should skip files that do not match *.command.json', async () => {
    createCommandManifest(workspaceDir, 'status.command.json', {
      name: 'runtime.status',
      aliases: ['/status'],
      permissions: ['read_status'],
      sideEffects: {},
    });
    // Create a non-command JSON file
    createCommandManifest(workspaceDir, 'config.json', { name: 'should-be-ignored' });

    const manifests = await router.discoverCommands();
    expect(manifests).toHaveLength(1);
  });

  it('should skip invalid command manifests', async () => {
    // Missing required "name" field
    createCommandManifest(workspaceDir, 'bad.command.json', {
      description: 'missing name',
    });

    const manifests = await router.discoverCommands();
    expect(manifests).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2. Alias resolution
  // -----------------------------------------------------------------------

  it('should resolve command aliases to canonical names', async () => {
    createCommandManifest(workspaceDir, 'status.command.json', {
      name: 'runtime.status',
      aliases: ['/status', 's'],
      permissions: ['read_status'],
      sideEffects: {},
    });
    await router.discoverCommands();

    expect(router.resolveCommand('runtime.status')).toBe('runtime.status');
    expect(router.resolveCommand('/status')).toBe('runtime.status');
    expect(router.resolveCommand('s')).toBe('runtime.status');
    expect(router.resolveCommand('unknown-cmd')).toBeUndefined();
  });

  it('should return all aliases via getAliases()', async () => {
    createCommandManifest(workspaceDir, 'status.command.json', {
      name: 'runtime.status',
      aliases: ['/status', 'status'],
      permissions: [],
      sideEffects: {},
    });
    createCommandManifest(workspaceDir, 'backtest.command.json', {
      name: 'backtest.run',
      aliases: ['/bt', 'bt'],
      permissions: ['run_backtest'],
      sideEffects: { runsBacktest: true },
    });
    await router.discoverCommands();

    const aliases = router.getAliases();
    expect(aliases.get('/status')).toBe('runtime.status');
    expect(aliases.get('status')).toBe('runtime.status');
    expect(aliases.get('/bt')).toBe('backtest.run');
    expect(aliases.get('bt')).toBe('backtest.run');
  });

  it('should fail closed when auth.json is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmd-router-no-auth-'));
    expect(() => new CommandRouter({ workspacePath: dir })).toThrow(/Missing or invalid auth configuration/i);
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 3. Handler registration
  // -----------------------------------------------------------------------

  it('should register and invoke a command handler', async () => {
    createCommandManifest(workspaceDir, 'greet.command.json', {
      name: 'greet',
      aliases: ['/hello'],
      permissions: [],
      sideEffects: {},
    });
    await router.discoverCommands();

    const handler: CommandHandler = async (ctx) => ({
      success: true,
      data: { greeting: `Hello, ${ctx.args.name ?? 'world'}!` },
      auditId: 'test-1',
    });

    router.registerHandler('greet', handler);

    const result = await router.execute('greet', makeContext({ args: { name: 'Tester' } }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ greeting: 'Hello, Tester!' });
  });

  it('should register multiple handlers at once via registerHandlers', async () => {
    createCommandManifest(workspaceDir, 'a.command.json', {
      name: 'cmd.a', aliases: [], permissions: [], sideEffects: {},
    });
    createCommandManifest(workspaceDir, 'b.command.json', {
      name: 'cmd.b', aliases: [], permissions: [], sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandlers({
      'cmd.a': async () => ({ success: true, data: 'A', auditId: 'a' }),
      'cmd.b': async () => ({ success: true, data: 'B', auditId: 'b' }),
    });

    expect(await router.execute('cmd.a', makeContext())).toMatchObject({ success: true, data: 'A' });
    expect(await router.execute('cmd.b', makeContext())).toMatchObject({ success: true, data: 'B' });
  });

  it('should throw ValidationError when registering empty handler name', () => {
    expect(() => router.registerHandler('', async () => ({ success: true, data: null, auditId: 'x' }))).toThrow(ValidationError);
  });

  it('should return handler names via getHandlerNames()', async () => {
    router.registerHandler('cmd.one', async () => ({ success: true, data: null, auditId: '1' }));
    router.registerHandler('cmd.two', async () => ({ success: true, data: null, auditId: '2' }));

    const names = router.getHandlerNames();
    expect(names).toContain('cmd.one');
    expect(names).toContain('cmd.two');
  });

  // -----------------------------------------------------------------------
  // 4. Execution workflow
  // -----------------------------------------------------------------------

  it('should reject unknown commands', async () => {
    // No manifests discovered
    const result = await router.execute('nonexistent', makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command');
  });

  it('should deny execution when permissions are insufficient', async () => {
    createCommandManifest(workspaceDir, 'secret.command.json', {
      name: 'super.secret',
      aliases: [],
      permissions: ['super_admin'],
      sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandler('super.secret', async () => ({
      success: true,
      data: 'secret data',
      auditId: 'x',
    }));

    const result = await router.execute('super.secret', makeContext({ actor: 'unauthorized_user', actorType: 'user' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  it('should fail when no handler is registered for a known command', async () => {
    createCommandManifest(workspaceDir, 'orphan.command.json', {
      name: 'orphan.command',
      aliases: [],
      permissions: [],
      sideEffects: {},
    });
    await router.discoverCommands();

    const result = await router.execute('orphan.command', makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No handler registered');
  });

  it('should handle handler exceptions gracefully', async () => {
    createCommandManifest(workspaceDir, 'crash.command.json', {
      name: 'crash',
      aliases: [],
      permissions: [],
      sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandler('crash', async () => {
      throw new Error('Handler exploded');
    });

    const result = await router.execute('crash', makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Handler exploded');
  });

  it('should execute via alias', async () => {
    createCommandManifest(workspaceDir, 'ping.command.json', {
      name: 'ping',
      aliases: ['/p'],
      permissions: [],
      sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandler('ping', async () => ({
      success: true,
      data: 'pong',
      auditId: 'pong-1',
    }));

    const result = await router.execute('/p', makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toBe('pong');
  });

  // -----------------------------------------------------------------------
  // 5. Audit
  // -----------------------------------------------------------------------

  it('should audit successful command executions', async () => {
    createCommandManifest(workspaceDir, 'audit-test.command.json', {
      name: 'audit.test',
      aliases: [],
      permissions: [],
      sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandler('audit.test', async () => ({
      success: true,
      data: 'ok',
      auditId: 'audit-1',
    }));

    const result = await router.execute('audit.test', makeContext({ args: { foo: 'bar' } }));
    expect(result.success).toBe(true);
    expect(result.auditId).toBeDefined();
    expect(result.auditId).toContain('audit.test_');
  });

  it('should audit denied command executions', async () => {
    createCommandManifest(workspaceDir, 'deny-test.command.json', {
      name: 'deny.test',
      aliases: [],
      permissions: ['super_admin'],
      sideEffects: {},
    });
    await router.discoverCommands();

    router.registerHandler('deny.test', async () => ({
      success: true,
      data: 'should not reach',
      auditId: 'x',
    }));

    const result = await router.execute('deny.test', makeContext({ actor: 'nobody', actorType: 'user' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  // -----------------------------------------------------------------------
  // 6. Default side effects and defaults
  // -----------------------------------------------------------------------

  it('should apply default values for optional manifest fields', async () => {
    createCommandManifest(workspaceDir, 'minimal.command.json', {
      name: 'minimal',
    });
    const manifests = await router.discoverCommands();
    const m = manifests[0]!;

    expect(m.description).toBe('');
    expect(m.aliases).toEqual([]);
    expect(m.permissions).toEqual([]);
    expect(m.sideEffects.readsMarketData).toBe(false);
    expect(m.riskLevel).toBe('low');
    expect(m.requiresApproval).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 7. getManifests lazy discovery
  // -----------------------------------------------------------------------

  it('should lazily discover manifests on getManifests()', async () => {
    // No discovery yet
    const before = await router.getManifests();
    expect(before).toHaveLength(0);

    // Now add a manifest and verify that getManifests has already cached nothing
    // Reset router so it re-discovers
    const router2 = new CommandRouter({ workspacePath: workspaceDir });
    createCommandManifest(workspaceDir, 'lazy.command.json', {
      name: 'lazy.test',
      permissions: [],
      sideEffects: {},
    });
    const manifests = await router2.getManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.name).toBe('lazy.test');
  });

  // -----------------------------------------------------------------------
  // 8. Error types
  // -----------------------------------------------------------------------

  it('should throw CommandNotFoundError when resolving unknown command', async () => {
    await router.discoverCommands();
    const resolved = router.resolveCommand('nothing');
    expect(resolved).toBeUndefined();
  });

  it('should produce a PermissionDeniedError with reasons', async () => {
    const err = new PermissionDeniedError('test.cmd', ['No channel access', 'Missing role']);
    expect(err.message).toContain('test.cmd');
    expect(err.message).toContain('No channel access');
    expect(err.name).toBe('PermissionDeniedError');
  });

  it('should produce a CommandNotFoundError with command name', async () => {
    const err = new CommandNotFoundError('ghost');
    expect(err.message).toContain('ghost');
    expect(err.name).toBe('CommandNotFoundError');
  });
});
