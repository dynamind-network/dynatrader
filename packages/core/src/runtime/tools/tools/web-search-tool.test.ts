import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchTool } from './web-search-tool.js';

afterEach(() => vi.unstubAllGlobals());

describe('WebSearchTool', () => {
  it('uses public DuckDuckGo search when no API provider is configured', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(`
      <div class="result">
        <a class="result__a" href="https://example.com/market">Markets today</a>
        <a class="result__snippet">Current market summary</a>
      </div>
    `, { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);

    const result = await new WebSearchTool().execute({ args: { query: 'markets today' } } as any);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ provider: 'duckduckgo', results: [{ title: 'Markets today', url: 'https://example.com/market' }] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls back to DuckDuckGo when a configured SearXNG instance fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('<div class="result"><a class="result__a" href="https://example.com">Result</a></div>', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await new WebSearchTool({ searxngBaseUrl: 'https://search.example/search' }).execute({ args: { query: 'market' } } as any);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ provider: 'duckduckgo', results: [{ title: 'Result' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
