import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from './google';

describe('GoogleProvider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('calls Gemini REST and maps system instructions and usage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      modelVersion: 'gemini-test', candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleProvider({ apiKey: 'test-key', baseUrl: 'https://google.test/v1beta' });
    const result = await provider.call({ model: 'google/gemini-test', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'hello' }] });
    expect(result).toMatchObject({ content: 'ok', provider: 'google', model: 'gemini-test', usage: { totalTokens: 5 } });
    expect(fetchMock).toHaveBeenCalledWith('https://google.test/v1beta/models/gemini-test:generateContent', expect.objectContaining({ headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }) }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.systemInstruction.parts[0].text).toBe('Be brief');
    expect(body.contents[0].role).toBe('user');
  });

  it('fails closed without an API key', () => {
    expect(() => new GoogleProvider({})).toThrow('GOOGLE_API_KEY');
  });

  it('preserves reasoning content when the model omits visible text', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      modelVersion: 'gemini-test',
      candidates: [{ reasoning_content: 'Working through the answer.', content: { parts: [] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GoogleProvider({ apiKey: 'test-key', baseUrl: 'https://google.test/v1beta' });
    const result = await provider.call({ messages: [{ role: 'user', content: 'hello' }] });

    expect(result.content).toBe('');
    expect(result.reasoningContent).toBe('Working through the answer.');
  });
});
