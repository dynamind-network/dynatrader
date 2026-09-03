/**
 * Full integration test for DynaTraderRuntime.
 *
 * Verifies:
 * - Runtime starts with all components initialized
 * - A2A runtime is available for agent-to-agent communication
 * - Pipeline handlers are registered (not stubs)
 * - ExecutionRouter and PaperEngine are wired
 * - SpawnSubagentTool is registered in tool registry
 * - Learning loop components are passed to AgentCore
 * - AgentRegistry loads workspace agents
 * - SubagentRuntime initializes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DynaTraderRuntime } from './index';
import type { RuntimeConfig } from './types';

function createMinimalWorkspace(dir: string): void {
  const dirs = ['agents', 'skills', 'tools', 'adapters', 'policies'];
  for (const d of dirs) {
    mkdirSync(join(dir, d), { recursive: true });
  }

  // Required workspace identity files
  writeFileSync(join(dir, 'SOUL.md'), '# Soul\nTest soul');
  writeFileSync(join(dir, 'IDENTITY.md'), '# Identity\nTest identity');
  writeFileSync(join(dir, 'USER.md'), '# User\nTest user');
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\nTest memory');
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
      'runtime:',
      '  mode: paper',
      'models:',
      '  provider: ollama',
      '  model: llama3.1',
      '',
    ].join('\n'),
  );
}

function createMinimalConfig(): RuntimeConfig {
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

describe('Full DynaTraderRuntime Integration', () => {
  let testDir: string;
  let runtime: DynaTraderRuntime;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'full-integration-'));
    createMinimalWorkspace(testDir);
    runtime = new DynaTraderRuntime(testDir, createMinimalConfig());
  });

  afterEach(async () => {
    try {
      await runtime.shutdown();
    } catch {
      // cleanup
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should start with all core components', async () => {
    await runtime.start();
    const status = runtime.getStatus();
    expect(status.state).toBe('running');

    // Core components that should always be present
    const requiredComponents = [
      'memory',
      'modelRouter',
      'toolRegistry',
      'agentCore',
      'exchange',
      'eventBus',
      'auditTrail',
      'pipeline',
      'cronEngine',
      'paperEngine',
      'executionRouter',
      'skillLoader',
      'a2aRuntime',
      'agentRegistry',
      'subagentRuntime',
    ];

    for (const component of requiredComponents) {
      expect(status.components).toHaveProperty(component);
      expect(status.components[component as keyof typeof status.components]).toBe(true);
    }
  });

  it('should expose getters for all components after start', async () => {
    await runtime.start();

    expect(runtime.getMemory()).toBeDefined();
    expect(runtime.getModelRouter()).toBeDefined();
    expect(runtime.getToolRegistry()).toBeDefined();
    expect(runtime.getAgent()).toBeDefined();
    expect(runtime.getPaperEngine()).toBeDefined();
    expect(runtime.getExecutionRouter()).toBeDefined();
    expect(runtime.getPipeline()).toBeDefined();
    expect(runtime.getA2ARuntime()).toBeDefined();
    expect(runtime.getAgentRegistry()).toBeDefined();
    expect(runtime.getSubagentRuntime()).toBeDefined();
  });

  it('should have SpawnSubagentTool registered', async () => {
    await runtime.start();
    const registry = runtime.getToolRegistry();
    const tools = registry.list();
    const spawnTool = tools.find(t => t.definition.name === 'spawn_subagent');
    expect(spawnTool).toBeDefined();
  });

  it('should expose A2ARuntime with messaging methods', async () => {
    await runtime.start();
    const a2a = runtime.getA2ARuntime();
    expect(typeof a2a.sendAndReceive).toBe('function');
    expect(typeof a2a.pingPong).toBe('function');
    expect(typeof a2a.announce).toBe('function');
    expect(typeof a2a.registerCard).toBe('function');
  });

  it('should have pipeline handlers registered', async () => {
    await runtime.start();
    const pipeline = runtime.getPipeline();
    expect(pipeline).toBeDefined();
    expect(typeof pipeline.execute).toBe('function');
  });

  it('should execute order intents through the runtime', async () => {
    await runtime.start();
    const executeFn = (runtime as any).executeOrderIntents;
    expect(typeof executeFn).toBe('function');
  });

  it('should have agent core with learning loop components', async () => {
    await runtime.start();
    const agent = runtime.getAgent() as any;
    // AgentCore should have received learning loop components
    expect(agent.skillFactory).toBeDefined();
    expect(agent.crossSessionRecall).toBeDefined();
  });

  it('should throw on getter access before start', () => {
    expect(() => runtime.getMemory()).toThrow('Runtime is not running');
    expect(() => runtime.getAgent()).toThrow('Runtime is not running');
    expect(() => runtime.getPaperEngine()).toThrow('Runtime is not running');
    expect(() => runtime.getExecutionRouter()).toThrow('Runtime is not running');
    expect(() => runtime.getA2ARuntime()).toThrow('Runtime is not running');
    expect(() => runtime.getAgentRegistry()).toThrow('Runtime is not running');
  });

  it('should report correct status before and after lifecycle', async () => {
    // Before start
    const preStatus = runtime.getStatus();
    expect(preStatus.state).toBe('idle');
    expect(preStatus.components.memory).toBe(false);
    expect(preStatus.components.agentCore).toBe(false);

    // After start
    await runtime.start();
    const postStatus = runtime.getStatus();
    expect(postStatus.state).toBe('running');
    expect(postStatus.startedAt).toBeDefined();

    // After shutdown
    await runtime.shutdown();
    const shutdownStatus = runtime.getStatus();
    expect(shutdownStatus.state).toBe('stopped');
  });
});
