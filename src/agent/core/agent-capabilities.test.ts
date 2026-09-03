import { describe, expect, it, vi } from 'vitest';
import { MemoryStoreImpl } from '@dyna/memory-core';
import { ToolRegistryImpl } from '../../runtime/tools/tool-registry';
import { AgentCore } from './agent-core';

function dependencies() {
  return {
    memory: new MemoryStoreImpl(),
  };
}

describe('general agent capabilities', () => {
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

  it('enforces read-only tools and planning instructions in plan mode', async () => {
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

    expect(request.messages[0].content).toContain('PLAN MODE IS ACTIVE for: Refactor the module');
    expect(request.tools.map((tool: any) => tool.name)).toEqual(['read']);
    agent.exitPlanMode('planning-session');
    expect(agent.isPlanMode('planning-session')).toBe(false);
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
});
