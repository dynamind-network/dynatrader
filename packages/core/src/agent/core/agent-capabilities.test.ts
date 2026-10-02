import { describe, expect, it, vi } from 'vitest';
import { MemoryStoreImpl } from '@dyna/memory-core';
import { ToolRegistryImpl } from '../../runtime/tools/tool-registry';
import { SkillLoader } from '../skills/skill-loader';
import { AgentCore } from './agent-core';

function dependencies() {
  return {
    memory: new MemoryStoreImpl(),
  };
}

describe('general agent capabilities', () => {
  it('advertises a single delegation tool with explicit sync and async modes', () => {
    const registry = new ToolRegistryImpl();
    const agent = new AgentCore({ ...dependencies(), toolRegistry: registry, delegateTask: vi.fn() });
    const tools = agent.listAvailableTools().map((tool) => tool.name);
    expect(tools).toContain('delegate_task');
    expect(tools).not.toContain('spawn_subagent');
    expect(registry.get('delegate_task')?.definition.inputSchema).toMatchObject({
      execution_mode: { enum: ['sync', 'async'] },
    });
  });

  it('registers and executes autonomous delegation', async () => {
    const registry = new ToolRegistryImpl();
    const delegateTask = vi.fn(async ({ task }) => ({ task, answer: 42 }));
    new AgentCore({ ...dependencies(), toolRegistry: registry, delegateTask });

    const result = await registry.execute({ tool: 'delegate_task', args: { task: 'inspect module' } });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ task: 'inspect module', answer: 42 });
    expect(delegateTask).toHaveBeenCalledWith(expect.objectContaining({ task: 'inspect module' }));
  });

  it('adds active goal context and records chat budget usage', async () => {
    let request: any;
    const modelRouter = {
      call: vi.fn(async (value) => {
        request = value;
        return { content: 'done', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      }),
    } as any;
    const agent = new AgentCore({ ...dependencies(), modelRouter });
    const goal = agent.getGoalManager().createGoal('work', 'Ship capability', 'Complete the general capability work');

    await agent.chat('continue', { sessionId: 'work' });

    expect(request.messages[0].content).toContain('ACTIVE GOAL: Ship capability');
    expect(goal.budget.currentTurns).toBe(1);
    expect(goal.budget.currentTokens).toBe(7);
  });

  it('enforces read-only tools during a plan request', async () => {
    let request: any;
    const modelRouter = {
      call: vi.fn(async (value) => {
        request = value;
        return { content: '# Plan\n1. Inspect the code', usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 } };
      }),
    } as any;
    const registry = new ToolRegistryImpl();
    const handler = (name: string, readOnly: boolean) => ({
      definition: { name, description: name, category: 'filesystem', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: [], riskLevel: 'low', timeoutMs: 1000, readOnly },
      execute: vi.fn(async () => ({ success: true, durationMs: 0, truncated: false })),
    }) as any;
    registry.register(handler('read', true));
    registry.register(handler('write', false));
    const agent = new AgentCore({ ...dependencies(), modelRouter, toolRegistry: registry });

    agent.enterPlanMode('planning-session', 'Refactor the module');
    await agent.chat('make a plan', { sessionId: 'planning-session' });

    expect(request.messages[0].content).toContain('A READ-ONLY PLAN REQUEST IS ACTIVE for: Refactor the module');
    const exposedTools = request.tools.map((tool: any) => tool.name);
    expect(exposedTools).toContain('read');
    expect(exposedTools).not.toContain('write');
    agent.exitPlanMode('planning-session');
    expect(agent.isPlanMode('planning-session')).toBe(false);
  });

  it('passes async execution mode through to the delegated task runner', async () => {
    const registry = new ToolRegistryImpl();
    const delegateTask = vi.fn(async (request) => ({ task_id: 'task-1', mode: request.executionMode }));
    new AgentCore({ ...dependencies(), toolRegistry: registry, delegateTask });

    const result = await registry.execute({ tool: 'delegate_task', args: { task: 'write a report', execution_mode: 'async' } });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ task_id: 'task-1', mode: 'async' });
    expect(delegateTask).toHaveBeenCalledWith(expect.objectContaining({ task: 'write a report', executionMode: 'async' }));
  });

  it('creates an isolated restricted AgentCore without changing the parent tool view', () => {
    const registry = new ToolRegistryImpl();
    const handler = (name: string) => ({
      definition: { name, description: name, category: 'filesystem', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: [], riskLevel: 'low', timeoutMs: 1000, readOnly: true },
      execute: vi.fn(async () => ({ success: true, durationMs: 0, truncated: false })),
    }) as any;
    registry.register(handler('read'));
    registry.register(handler('write'));
    const parent = new AgentCore({ ...dependencies(), toolRegistry: registry });

    const child = parent.createRestrictedChild(['read']);

    expect(child).not.toBe(parent);
    expect(child.listAvailableTools().map((tool) => tool.name)).toEqual(['read']);
    expect(parent.listAvailableTools().map((tool) => tool.name)).toContain('write');
  });

  it('injects delegated instructions into the child chat system message', async () => {
    let request: any;
    const modelRouter = {
      call: vi.fn(async (value) => {
        request = value;
        return { content: 'child done', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      }),
    } as any;
    const child = new AgentCore({ ...dependencies(), modelRouter });

    await child.chat('inspect this', { sessionId: 'child-test', systemInstructions: 'You are the code reviewer.' });

    expect(request.messages[0].content).toContain('DELEGATED AGENT INSTRUCTIONS');
    expect(request.messages[0].content).toContain('You are the code reviewer.');
  });

  it('exposes Hermes-style skill list and view tools in plan mode', async () => {
    const registry = new ToolRegistryImpl();
    const skillLoader = new SkillLoader();
    await skillLoader.loadAll();
    const agent = new AgentCore({ ...dependencies(), toolRegistry: registry, skillLoader });
    agent.enterPlanMode('skill-session', 'inspect available skills');

    const tools = agent.listAvailableTools('skill-session');
    expect(tools.map((tool) => tool.name)).toContain('skills_list');
    expect(tools.map((tool) => tool.name)).toContain('skill_view');
    expect(tools.filter((tool) => ['skills_list', 'skill_view'].includes(tool.name)).every((tool) => tool.readOnly)).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain('skill_catalog');
  });

  it('applies Terminal tool policy inside the DynaTrader runtime SDK', () => {
    const registry = new ToolRegistryImpl();
    const handler = (name: string) => ({
      definition: { name, description: name, category: 'filesystem', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: [], riskLevel: 'low', timeoutMs: 1000, readOnly: true },
      execute: vi.fn(async () => ({ success: true, durationMs: 0, truncated: false })),
    }) as any;
    registry.register(handler('read'));
    registry.register(handler('glob'));
    registry.register(handler('write'));
    const agent = new AgentCore({ ...dependencies(), toolRegistry: registry });

    agent.setToolPolicy('session-1', ['read', 'glob'], ['glob']);

    expect(agent.listAvailableTools('session-1').map((tool) => tool.name)).toEqual(['read']);
  });

  it('gates mutating tools through the runtime approval handler', async () => {
    const registry = new ToolRegistryImpl();
    registry.register({
      definition: { name: 'write', description: 'write', category: 'filesystem', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: ['writes_files'], riskLevel: 'medium', timeoutMs: 1000 },
      execute: vi.fn(async () => ({ success: true, durationMs: 0, truncated: false })),
    } as any);
    const requestToolApproval = vi.fn(async () => false);
    const agent = new AgentCore({ ...dependencies(), toolRegistry: registry, requestToolApproval });

    const partition = await (agent as any).partitionApprovedToolCalls([{ tool: 'write', args: { path: 'x' }, id: 'call-1' }]);

    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(partition.approved).toEqual([]);
    expect(partition.denied[0].result).toMatchObject({ success: false, error: 'User denied this tool call.' });
  });

it('brokers first-party SDK calls from any host that resolves core profiles', async () => {
    const registry = new ToolRegistryImpl();
    const marketExecute = vi.fn(async () => ({ success: true, data: { price: 12 }, durationMs: 0, truncated: false }));
    registry.register({
      definition: { name: 'node_repl', description: 'persistent JavaScript REPL', category: 'exec', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: [], riskLevel: 'low', timeoutMs: 1000, readOnly: true },
      execute: vi.fn(),
    } as any);
    registry.register({
      definition: { name: 'market_data', description: 'market data', category: 'market', inputSchema: {}, outputSchema: {}, permissionsRequired: [], sideEffects: [], riskLevel: 'low', timeoutMs: 1000, readOnly: true },
      execute: marketExecute,
    } as any);
    // A bare host: no plugin profiles requested. `base` is a core profile, so
    // the SDK surface is reachable without opting into anything -- that is what
    // lets the desktop's stdio agent reach market data at all.
    const agent = new AgentCore({ ...dependencies(), toolRegistry: registry });

    const allowed = await agent.executeSdkTool({ tool: 'market_data', args: { action: 'price', symbol: 'BTC/USD' } }, { sessionId: 'repl-1' });
    const blockedAction = await agent.executeSdkTool({ tool: 'market_data', args: { action: 'balances' } }, { sessionId: 'repl-1' });
    const unregistered = await agent.executeSdkTool({ tool: 'not_a_capability', args: {} }, { sessionId: 'repl-1' });

    expect(allowed).toMatchObject({ success: true, data: { price: 12 } });
    expect(blockedAction).toMatchObject({ success: false });
    expect(unregistered).toMatchObject({ success: false });
    expect(marketExecute).toHaveBeenCalledOnce();
  });
});
