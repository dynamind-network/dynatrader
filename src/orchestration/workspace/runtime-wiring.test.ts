/**
 * Tests for Tasks 12 & 15: Wire CronEngine and Learning Loop into DynaTraderRuntime.
 *
 * Verifies that:
 * - CronEngine is initialized and started on runtime start
 * - Learning loop components (SkillFactory, CrossSessionRecall) are initialized
 * - CronEngine is stopped on runtime shutdown
 * - Status includes all new components
 * - Getters return the initialized components
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DynaTraderRuntime } from './index';
import { AgentCore } from '../../agent/core/agent-core';
import { CronEngine } from '@dyna/agent-cron';
import type { RuntimeConfig } from './types';

function createMinimalWorkspace(dir: string): void {
  // Create required directories
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'adapters'), { recursive: true });
  mkdirSync(join(dir, 'policies'), { recursive: true });

  // Create required files (workspace-loader validates these exist)
  writeFileSync(join(dir, 'SOUL.md'), '# Soul\nTest workspace');
  writeFileSync(join(dir, 'IDENTITY.md'), '# Identity\nTest');
  writeFileSync(join(dir, 'USER.md'), '# User\nTest');
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\nTest');
  writeFileSync(
    join(dir, 'auth.json'),
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
    }, null, 2),
  );
  writeFileSync(
    join(dir, 'config.yaml'),
    [
      'name: test',
      'exchange:',
      '  id: binance',
      'models:',
      '  provider: ollama',
      '  model: llama3.1',
      '',
    ].join('\n'),
  );
}

function createRuntimeConfig(): RuntimeConfig {
  return {
    workspacePath: '/tmp/test',
    mode: 'paper',
    strictMode: false,
    requireRiskProfile: false,
    requireTradingPolicy: false,
    requireAuthConfig: false,
    liveTradingEnabled: false,
    enableShadowMode: false,
    enableMicroLiveMode: false,
  };
}

describe('DynaTraderRuntime wiring', () => {
  let testDir: string;
  let runtime: DynaTraderRuntime;

  beforeEach(() => {
    // Create a temp workspace directory
    testDir = mkdtempSync(join(tmpdir(), 'runtime-wiring-test-'));
    createMinimalWorkspace(testDir);

    runtime = new DynaTraderRuntime(testDir, createRuntimeConfig());
  });

  afterEach(async () => {
    // Ensure runtime is shut down to clean up CronEngine interval
    try {
      await runtime.shutdown();
    } catch {
      // Ignore errors during cleanup
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Component initialization', () => {
    it('should initialize CronEngine on start()', async () => {
      const startSpy = vi.spyOn(CronEngine.prototype, 'start');
      const initSpy = vi.spyOn(CronEngine.prototype, 'initialize');

      await runtime.start();

      expect(initSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();

      // Clean up spies after this test
      startSpy.mockRestore();
      initSpy.mockRestore();
    }, 30_000);

    it('should initialize all learning loop components on start()', async () => {
      await runtime.start();

      expect(runtime.getSkillFactory()).toBeDefined();
      expect(runtime.getCrossSessionRecall()).toBeDefined();
    });

    it('should initialize dreaming cycle components on start()', async () => {
      await runtime.start();

      expect(runtime.getDreamEngine()).toBeDefined();
      expect(runtime.getDreamScheduler()).toBeDefined();
      // DreamEngine has runDreamCycle method
      expect(typeof runtime.getDreamEngine().runDreamCycle).toBe('function');
      // DreamScheduler has start/stop lifecycle
      expect(typeof runtime.getDreamScheduler().start).toBe('function');
      expect(typeof runtime.getDreamScheduler().stop).toBe('function');
    });

    it('should load BOOT.md on gateway startup when present', async () => {
      writeFileSync(
        join(testDir, 'BOOT.md'),
        '# Startup Checklist\n- Verify cron jobs.\n- Reply with [SILENT] if nothing needs attention.',
      );

      const chatSpy = vi.spyOn(AgentCore.prototype, 'chat').mockResolvedValue({
        content: '[SILENT]',
        state: 'idle',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: 0,
        compacted: false,
      } as any);

      await runtime.start();

      expect(chatSpy).toHaveBeenCalled();
      const [message] = chatSpy.mock.calls[0] ?? [];
      expect(String(message)).toContain('startup checklist');
      chatSpy.mockRestore();
    });

    it('should initialize PaperEngine on start()', async () => {
      await runtime.start();
      expect(runtime.getPaperEngine()).toBeDefined();
    });

    it('initializes StateDb at the workspace state.db path', async () => {
      await runtime.start();
      const stateDb = runtime.getStateDb();
      expect(stateDb).not.toBeNull();
      expect(stateDb?.path).toBe(join(testDir, 'state.db'));
    });

    it('should initialize ExecutionRouter on start()', async () => {
      await runtime.start();
      expect(runtime.getExecutionRouter()).toBeDefined();
    });

    it('should register native session tools on start()', async () => {
      await runtime.start();
      const toolNames = runtime.getToolRegistry().list().map((tool) => tool.definition.name);
      expect(toolNames).toContain('sessions_list');
      expect(toolNames).toContain('sessions_history');
      expect(toolNames).toContain('sessions_send');
      expect(toolNames).toContain('session_status');
      expect(toolNames).toContain('session_search');
    });

    it('should transition to running state after successful start', async () => {
      const statusBefore = runtime.getStatus();
      expect(statusBefore.state).toBe('idle');

      await runtime.start();

      const statusAfter = runtime.getStatus();
      expect(statusAfter.state).toBe('running');
    });

    it('should fail closed in strict mode when no workspace MCP servers are configured', async () => {
      runtime = new DynaTraderRuntime(testDir, {
        ...createRuntimeConfig(),
        strictMode: true,
      });

      await expect(runtime.start()).rejects.toThrow(/MCP server/i);
    });
  });

  describe('Getters', () => {
    it('should provide getCronEngine() after start', async () => {
      await runtime.start();
      const engine = runtime.getCronEngine();
      expect(engine).toBeInstanceOf(CronEngine);
      expect(engine).toHaveProperty('start');
      expect(engine).toHaveProperty('stop');
    });

    it('should provide getSkillFactory() after start', async () => {
      await runtime.start();
      expect(runtime.getSkillFactory()).toBeDefined();
      // SkillFactory has a createStrategy method
      expect(typeof runtime.getSkillFactory().createStrategy).toBe('function');
    });

    it('should provide getCrossSessionRecall() after start', async () => {
      await runtime.start();
      expect(runtime.getCrossSessionRecall()).toBeDefined();
      expect(typeof runtime.getCrossSessionRecall().index).toBe('function');
      expect(typeof runtime.getCrossSessionRecall().search).toBe('function');
    });

    it('should provide getDreamEngine() after start', async () => {
      await runtime.start();
      const engine = runtime.getDreamEngine();
      expect(engine).toBeDefined();
      expect(typeof engine.runDreamCycle).toBe('function');
      expect(typeof engine.runDreamCycleIfNeeded).toBe('function');
      expect(typeof engine.getLastDreamReport).toBe('function');
    });

    it('should provide getDreamScheduler() after start', async () => {
      await runtime.start();
      const scheduler = runtime.getDreamScheduler();
      expect(scheduler).toBeDefined();
      expect(typeof scheduler.start).toBe('function');
      expect(typeof scheduler.stop).toBe('function');
      expect(typeof scheduler.triggerNow).toBe('function');
    });

    it('should throw if getters are accessed before start', () => {
      expect(() => runtime.getCronEngine()).toThrow('Runtime is not running');
      expect(() => runtime.getSkillFactory()).toThrow('Runtime is not running');
      expect(() => runtime.getCrossSessionRecall()).toThrow('Runtime is not running');
      expect(() => runtime.getDreamEngine()).toThrow('Runtime is not running');
      expect(() => runtime.getDreamScheduler()).toThrow('Runtime is not running');
      expect(() => runtime.getPaperEngine()).toThrow('Runtime is not running');
      expect(() => runtime.getExecutionRouter()).toThrow('Runtime is not running');
    });
  });

  describe('RuntimeStatus', () => {
    it('should report all new components as false before start', () => {
      const status = runtime.getStatus();
      expect(status.components.cronEngine).toBe(false);
      expect(status.components.skillFactory).toBe(false);
      expect(status.components.crossSessionRecall).toBe(false);
      expect(status.components.pluginRuntime).toBe(false);
      expect(status.components.dreamEngine).toBe(false);
      expect(status.components.dreamScheduler).toBe(false);
      expect(status.components.paperEngine).toBe(false);
      expect(status.components.executionRouter).toBe(false);
    });

    it('should report all new components as true after start', async () => {
      await runtime.start();
      const status = runtime.getStatus();
      expect(status.components.cronEngine).toBe(true);
      expect(status.components.skillFactory).toBe(true);
      expect(status.components.crossSessionRecall).toBe(true);
      expect(status.components.pluginRuntime).toBe(true);
      expect(status.components.dreamEngine).toBe(true);
      expect(status.components.dreamScheduler).toBe(true);
      expect(status.components.paperEngine).toBe(true);
      expect(status.components.executionRouter).toBe(true);
    });

    it('should include new component keys in status', async () => {
      await runtime.start();
      const status = runtime.getStatus();
      const componentKeys = Object.keys(status.components);
      expect(componentKeys).toContain('cronEngine');
      expect(componentKeys).toContain('skillFactory');
      expect(componentKeys).toContain('crossSessionRecall');
      expect(componentKeys).toContain('skillReviewer');
      expect(componentKeys).toContain('pluginRuntime');
      expect(componentKeys).toContain('dreamEngine');
      expect(componentKeys).toContain('dreamScheduler');
      expect(componentKeys).toContain('paperEngine');
      expect(componentKeys).toContain('executionRouter');
    });
  });

  describe('Shutdown', () => {
    it('should stop CronEngine on shutdown()', async () => {
      await runtime.start();

      const stopSpy = vi.spyOn(CronEngine.prototype, 'stop');

      await runtime.shutdown();

      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });

    it('should transition to stopped state after shutdown', async () => {
      await runtime.start();
      await runtime.shutdown();
      expect(runtime.getStatus().state).toBe('stopped');
    });

    it('should be safe to call shutdown() multiple times', async () => {
      await runtime.start();
      await runtime.shutdown();
      // Second shutdown should not throw
      await expect(runtime.shutdown()).resolves.toBeUndefined();
    });
  });
});
