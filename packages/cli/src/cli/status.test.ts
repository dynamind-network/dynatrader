import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdStatus } from './status';

afterEach(() => vi.restoreAllMocks());

describe('status JSON output', () => {
  it('prints one parseable structured runtime and workspace report', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runtime = {
      getStatus: () => ({
        state: 'running', startedAt: new Date('2026-10-01T00:00:00.000Z'), workspacePath: 'C:/workspace', mode: 'paper',
        components: { memory: true, modelRouter: true, toolRegistry: true, pluginRuntime: true, agentCore: true, loopSync: false, exchange: false, eventBus: true, auditTrail: true, pipeline: true, cronEngine: false, skillFactory: false, skillReviewer: false, crossSessionRecall: false },
      }),
      getModelRouter: () => ({ getCostStats: async () => ({ callsByProvider: { dynamind: 1 } }) }),
      getSkillFactory: () => ({ listSkills: async () => [] }),
      getExchange: () => ({ id: 'paper' }),
    } as any;
    const workspace = { agents: [{ name: 'main' }], skills: [], tools: [], adapters: [], loops: [], policies: [] } as any;

    await cmdStatus(runtime, workspace, { json: true });

    const report = JSON.parse(log.mock.calls[0]![0] as string);
    expect(report).toMatchObject({
      state: 'running', mode: 'paper', workspacePath: 'C:/workspace', providers: ['dynamind'],
      workspace: { agents: ['main'], learnedSkills: 0 },
    });
    expect(log).toHaveBeenCalledOnce();
  });
});
