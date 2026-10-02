import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenRouterProvider } from './openrouter';

describe('OpenRouterProvider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the OpenAI-compatible endpoint and strips provider prefixes', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      model: 'anthropic/claude-3.5-sonnet',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: 'https://router.test/v1' });
    const result = await provider.call({ model: 'openrouter/anthropic/claude-3.5-sonnet', messages: [{ role: 'user', content: 'hello' }] });
    expect(result.provider).toBe('openrouter');
    expect(result.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith('https://router.test/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('anthropic/claude-3.5-sonnet');
  });
});
