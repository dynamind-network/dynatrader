import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';

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
      const results = this.config.tavilyApiKey ? await this.tavily(query, call.args.maxResults) : this.config.braveApiKey ? await this.brave(query, call.args.maxResults) : await this.searxng(query, call.args.maxResults);
      return { success: true, data: { query, results }, durationMs: Date.now() - start, truncated: false };
    } catch (error) { return { success: false, error: (error as Error).message, durationMs: Date.now() - start, truncated: false }; }
  }
  private async json(url: string, init: RequestInit): Promise<any> { const c = new AbortController(); const t = setTimeout(() => c.abort(), this.config.timeoutMs); try { const r = await fetch(url, { ...init, signal: c.signal }); if (!r.ok) throw new Error(`Search provider returned HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); } }
  private async tavily(query: string, maxResults: unknown) { const d = await this.json('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: this.config.tavilyApiKey, query, max_results: typeof maxResults === 'number' ? maxResults : 5 }) }); return (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })); }
  private async brave(query: string, maxResults: unknown) { const u = new URL('https://api.search.brave.com/res/v1/web/search'); u.searchParams.set('q', query); u.searchParams.set('count', String(typeof maxResults === 'number' ? maxResults : 5)); const d = await this.json(u.toString(), { headers: { 'X-Subscription-Token': this.config.braveApiKey!, Accept: 'application/json' } }); return (d.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })); }
  private async searxng(query: string, maxResults: unknown) { if (!this.config.searxngBaseUrl) throw new Error('No web search provider configured (set BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_BASE_URL)'); const u = new URL(this.config.searxngBaseUrl); u.searchParams.set('q', query); u.searchParams.set('format', 'json'); const d = await this.json(u.toString(), {}); return (d.results ?? []).slice(0, typeof maxResults === 'number' ? maxResults : 5).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })); }
}
