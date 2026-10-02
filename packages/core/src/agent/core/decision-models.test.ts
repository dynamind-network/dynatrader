import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessDecisionController, JevDecisionProvider } from './decision-models';

describe('decision models', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends typed questions and reads a Jev choice response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { decision: { type: 'choice', choice: 'change_approach', confidence: 0.92 } },
      usage: { input_tokens: 80, output_tokens: 12 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new JevDecisionProvider('test-key');
    const result = await provider.evaluate({ kind: 'recovery', state: { error: 'bad args' } });
    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(sent.questions.decision.type).toBe('choice');
    expect(result).toMatchObject({ choice: 'change_approach', confidence: 0.92, inputTokens: 80 });
  });

  it('keeps provider failures advisory and accounts for them', async () => {
    const provider = { name: 'test', evaluate: vi.fn().mockRejectedValue(new Error('offline')) };
    const controller = new HarnessDecisionController(provider);
    const result = await controller.evaluate({ kind: 'command-risk', state: { command: 'echo hi' } });
    expect(result).toBeUndefined();
    expect(controller.getMetrics()).toMatchObject({ calls: 1, failures: 1, byKind: { 'command-risk': 1 } });
  });

  it('does not invoke disabled decision features', async () => {
    const provider = { name: 'test', evaluate: vi.fn() };
    const controller = new HarnessDecisionController(provider, { completion: false });
    expect(await controller.evaluate({ kind: 'completion', state: {} })).toBeUndefined();
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
});
