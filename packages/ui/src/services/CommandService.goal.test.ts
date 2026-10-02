import { describe, expect, it, vi } from 'vitest';
import { CommandService } from './CommandService.js';
import type { AgentLoop } from '../core/agent-loop.js';

describe('CommandService persistent goal callbacks', () => {
  it('routes goal commands through the AgentLoop Core RPC adapter', async () => {
    const goal = {
      id: 'g1', title: 'Ship release', description: 'Ship release', status: 'active', sessionId: 's1',
      progress: { stepsCompleted: 1, totalSteps: 2, percentComplete: 50 }, tokenBudget: 100, tokensUsed: 5,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const manageGoal = vi.fn(async (action: string) => ({
      action,
      changed: true,
      goal: action === 'status' ? goal : null,
      goals: [goal],
    }));
    const agentLoop = { manageGoal } as unknown as AgentLoop;
    const messages: Array<{ content: string }> = [];
    const service = new CommandService({
      agentLoop,
      cwd: process.cwd(),
      getConversationId: () => 's1',
      onMessage: (message) => messages.push(message),
      onProcessingChange: vi.fn(),
      onToolChange: vi.fn(),
      onModelChange: vi.fn(),
      onActiveToolsChange: vi.fn(),
      onNavigate: vi.fn(),
      onConnectProvider: vi.fn(),
      onClearSession: vi.fn(),
      onListSessions: async () => '',
      onResumeSession: async () => ({ success: true, message: 'resumed' }),
      onQuestionRequired: async () => null,
      onStartAgentCreate: vi.fn(),
      onAuthChanged: async () => {},
      onSubagentsChanged: async () => {},
      onShowSessionPicker: vi.fn(),
      currentModel: 'test/model',
    });

    await service.executeCommand('/goal set Ship release');
    await service.executeCommand('/goal status');
    await service.executeCommand('/goal list');
    await service.executeCommand('/goal pause');
    await service.executeCommand('/goal resume');
    await service.executeCommand('/goal complete');
    await service.executeCommand('/goal clear');

    expect(manageGoal.mock.calls).toEqual([
      ['set', 'Ship release'], ['status'], ['list'], ['pause'], ['resume'], ['complete'], ['clear'],
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      'Goal set: "Ship release"',
      expect.stringContaining('Active goal: "Ship release"'),
      '- [active] Ship release',
      'Goal paused.',
      'Goal resumed.',
      'Goal marked as complete.',
      'Goal cleared.',
    ]);
  });

  it('surfaces unavailable Core goal support rather than reporting a false success', async () => {
    const messages: Array<{ content: string }> = [];
    const service = new CommandService({
      cwd: process.cwd(), getConversationId: () => 's1', onMessage: (message) => messages.push(message),
      onProcessingChange: vi.fn(), onToolChange: vi.fn(), onModelChange: vi.fn(), onActiveToolsChange: vi.fn(),
      onNavigate: vi.fn(), onConnectProvider: vi.fn(), onClearSession: vi.fn(), onListSessions: async () => '',
      onResumeSession: async () => ({ success: true, message: 'resumed' }), onQuestionRequired: async () => null,
      onStartAgentCreate: vi.fn(), onAuthChanged: async () => {}, onSubagentsChanged: async () => {},
      onShowSessionPicker: vi.fn(), currentModel: null,
    });
    await service.executeCommand('/goal set Ship release');
    expect(messages.at(-1)?.content).toContain('initialized Core runtime');
    expect(messages.at(-1)?.content).not.toContain('Goal set:');
  });
});
