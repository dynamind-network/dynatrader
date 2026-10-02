import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';
import { load } from 'cheerio';

export interface WebSearchConfig { braveApiKey?: string; tavilyApiKey?: string; searxngBaseUrl?: string; timeoutMs?: number; }

export class WebSearchTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'web_search', description: 'Search the web and return ranked sources.', category: 'web',
    inputSchema: { query: 'string', maxResults: 'number?' }, outputSchema: { results: 'array' },
    permissionsRequired: ['tool.web_search'], sideEffects: ['network_access'], riskLevel: 'low', readOnly: true, timeoutMs: 30000,
  };
  private readonly config: WebSearchConfig;
  constructor(config: WebSearchConfig = {}) { this.config = { ...config, timeoutMs: config.timeoutMs ?? 15000 }; }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now(); const query = call.args.query;
    if (typeof query !== 'string' || !query.trim()) return { success: false, error: 'query must be a non-empty string', durationMs: 0, truncated: false };
    try {
      const maxResults = normalizeMaxResults(call.args.maxResults);
      const { provider, results } = await this.search(query, maxResults);
      return { success: true, data: { query, provider, results }, durationMs: Date.now() - start, truncated: false };
    } catch (error) { return { success: false, error: (error as Error).message, durationMs: Date.now() - start, truncated: false }; }
  }
  private async json(url: string, init: RequestInit): Promise<any> { const c = new AbortController(); const t = setTimeout(() => c.abort(), this.config.timeoutMs); try { const r = await fetch(url, { ...init, signal: c.signal }); if (!r.ok) throw new Error(`Search provider returned HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); } }
  private async search(query: string, maxResults: number): Promise<{ provider: string; results: SearchResult[] }> {
    if (this.config.tavilyApiKey) return { provider: 'tavily', results: await this.tavily(query, maxResults) };
    if (this.config.braveApiKey) return { provider: 'brave', results: await this.brave(query, maxResults) };
    if (this.config.searxngBaseUrl) {
      try { return { provider: 'searxng', results: await this.searxng(query, maxResults) }; }
      catch (error) { console.warn(`Configured SearXNG search failed; using public DuckDuckGo search: ${(error as Error).message}`); }
    }
    return { provider: 'duckduckgo', results: await this.duckDuckGo(query, maxResults) };
  }

  private async tavily(query: string, maxResults: number): Promise<SearchResult[]> {
    const d = await this.json('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: this.config.tavilyApiKey, query, max_results: maxResults }) });
    return (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
  }

  private async brave(query: string, maxResults: number): Promise<SearchResult[]> {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query); u.searchParams.set('count', String(maxResults));
    const d = await this.json(u.toString(), { headers: { 'X-Subscription-Token': this.config.braveApiKey!, Accept: 'application/json' } });
    return (d.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description }));
  }

  private async searxng(query: string, maxResults: number): Promise<SearchResult[]> {
    const u = new URL(this.config.searxngBaseUrl!);
    u.searchParams.set('q', query); u.searchParams.set('format', 'json');
    const d = await this.json(u.toString(), {});
    return (d.results ?? []).slice(0, maxResults).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
  }

  private async duckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let html: string;
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DynaTrader/3.0; +https://github.com/dynamind-network/dynatrader)', Accept: 'text/html' } });
      if (!response.ok) throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
      html = await response.text();
    } finally { clearTimeout(timer); }

    const $ = load(html);
    const results: SearchResult[] = [];
    $('.result').each((_index, element) => {
      if (results.length >= maxResults) return;
      const anchor = $(element).find('.result__a').first();
      const title = anchor.text().trim();
      const href = anchor.attr('href');
      if (!title || !href) return;
      let resultUrl = href;
      try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        resultUrl = parsed.searchParams.get('uddg') ?? parsed.toString();
      } catch { /* Keep provider result URL; consumers can reject malformed links. */ }
      results.push({ title, url: resultUrl, snippet: $(element).find('.result__snippet').text().replace(/\s+/g, ' ').trim() });
    });
    if (results.length === 0) throw new Error('DuckDuckGo returned no parseable results (the provider may be rate-limiting this request).');
    return results;
  }
}

type SearchResult = { title: string; url: string; snippet: string };

function normalizeMaxResults(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 5;
}
