import { describe, expect, it, vi } from 'vitest';
import type { AgentLoop } from '../src/core/agent-loop.js';
import { CommandService } from '../src/services/CommandService.js';

function makeCommandService(agentLoop: AgentLoop, onMessage = vi.fn()) {
  const processingChanges: boolean[] = [];
  const service = new CommandService({
    agentLoop,
    cwd: 'C:/workspace/project',
    getConversationId: () => 'session-1',
    onMessage,
    onProcessingChange: (processing) => processingChanges.push(processing),
    onToolChange: () => {},
    onModelChange: () => {},
    onActiveToolsChange: () => {},
    onNavigate: () => {},
    onConnectProvider: () => {},
    onClearSession: () => {},
    onListSessions: async () => '',
    onResumeSession: async () => ({ success: true, message: '' }),
    onQuestionRequired: async () => null,
    onStartAgentCreate: () => {},
    onAuthChanged: async () => {},
    onSubagentsChanged: async () => {},
    onShowSessionPicker: () => {},
    currentModel: 'test-model',
  });
  return { service, processingChanges };
}

describe('/plan command execution', () => {
  it('runs one read-only planning pass and exits planning before returning', async () => {
    const setPlanningMode = vi.fn(async () => {});
    const run = vi.fn(async () => 'plan response');
    const agentLoop = { setPlanningMode, run } as unknown as AgentLoop;
    const onMessage = vi.fn();
    const { service, processingChanges } = makeCommandService(agentLoop, onMessage);

    await service.executeCommand('/plan inspect authentication flow');

    expect(setPlanningMode.mock.calls).toEqual([
      [true, 'inspect authentication flow'],
      [false],
    ]);
    expect(run).toHaveBeenCalledWith('inspect authentication flow', {
      workingDirectory: 'C:/workspace/project',
      conversationId: 'session-1',
      isSubagent: false,
    });
    expect(processingChanges).toEqual([true, false]);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Plan ready for review.' })
    );
  });

  it('restores normal mode when the planning pass fails', async () => {
    const setPlanningMode = vi.fn(async () => {});
    const run = vi.fn(async () => {
      throw new Error('planner failed');
    });
    const agentLoop = { setPlanningMode, run } as unknown as AgentLoop;
    const onMessage = vi.fn();
    const { service, processingChanges } = makeCommandService(agentLoop, onMessage);

    await service.executeCommand('/plan inspect authentication flow');

    expect(setPlanningMode.mock.calls).toEqual([
      [true, 'inspect authentication flow'],
      [false],
    ]);
    expect(processingChanges).toEqual([true, false]);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Command /plan failed: planner failed' })
    );
  });
});
