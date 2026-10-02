import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import { load } from 'cheerio';

export interface WebFetchToolConfig {
  defaultTimeout?: number;
  maxResponseLength?: number;
  respectRobotsTxt?: boolean;
}

export class WebFetchTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'web_fetch',
    description: 'Fetch content from URLs and return as text, markdown, or html',
    category: 'web',
    inputSchema: {
      url: 'string',
      format: 'string?',
      timeout: 'number?',
    },
    outputSchema: {
      content: 'string',
      format: 'string',
      contentType: 'string',
      statusCode: 'number',
    },
    permissionsRequired: ['tool.web_fetch'],
    sideEffects: ['network_access'],
    riskLevel: 'low',
    readOnly: true,
    timeoutMs: 30000,
  };

  private defaultTimeout: number;
  private maxResponseLength: number;
  private respectRobotsTxt: boolean;

  constructor(config?: WebFetchToolConfig) {
    this.defaultTimeout = config?.defaultTimeout ?? 30000;
    this.maxResponseLength = config?.maxResponseLength ?? 5 * 1024 * 1024; // 5MB
    this.respectRobotsTxt = config?.respectRobotsTxt ?? false;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const url = call.args.url;
      if (typeof url !== 'string' || !url.trim()) {
        return {
          success: false,
          error: 'URL must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return {
          success: false,
          error: `Invalid URL: ${url}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return {
          success: false,
          error: `Unsupported protocol: ${parsedUrl.protocol}. Only http and https are supported.`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const requestedFormat = (call.args.format as string | undefined) ?? 'markdown';
      const format = ['markdown', 'text', 'html', 'json'].includes(requestedFormat) ? requestedFormat : 'markdown';
      const timeout = (call.args.timeout as number | undefined) ?? this.defaultTimeout;

      // Block private/internal IPs (SSRF protection)
      const hostname = parsedUrl.hostname;
      const privatePatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1|fc|fd)/;
      if (privatePatterns.test(hostname)) {
        return {
          success: false,
          error: 'URL points to a private/internal address (SSRF blocked)',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Dyna-Trader/1.0',
            'Accept': 'text/html,text/plain,application/json,*/*',
          },
        });

        const contentType = response.headers.get('content-type') ?? 'text/plain';
        const statusCode = response.status;

        if (!response.ok) {
          return {
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
            data: { statusCode, contentType },
            durationMs: Date.now() - start,
            truncated: false,
          };
        }

        // Check content length header
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > this.maxResponseLength) {
          return {
            success: false,
            error: `Response too large (${contentLength} bytes > ${this.maxResponseLength} bytes)`,
            durationMs: Date.now() - start,
            truncated: false,
          };
        }

        const rawContent = await response.text();
        const content = formatFetchedContent(rawContent, contentType, format, parsedUrl.toString());

        if (content.length > this.maxResponseLength) {
          return {
            success: true,
            data: {
              content: content.slice(0, this.maxResponseLength) + '\n... [truncated]',
              format,
              contentType,
              statusCode,
            },
            durationMs: Date.now() - start,
            truncated: true,
          };
        }

        return {
          success: true,
          data: {
            content,
            format,
            contentType,
            statusCode,
          },
          durationMs: Date.now() - start,
          truncated: false,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timed out',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }
      return {
        success: false,
        error: error.message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}

export function formatFetchedContent(rawContent: string, contentType: string, format: string, baseUrl?: string): string {
  if (format === 'html') return rawContent;
  const isJson = format === 'json' || /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType);
  if (isJson) {
    try { return JSON.stringify(JSON.parse(rawContent), null, 2); }
    catch { return rawContent; }
  }
  if (!/html|xhtml/i.test(contentType)) return rawContent;

  const $ = load(rawContent);
  $('script,style,noscript,svg,canvas,nav,footer,header,aside,form,button,iframe,dialog').remove();
  let root = $('main,[role="main"],article').first();
  if (!root.length) root = $('body');
  root.find('a').each((_index, element) => {
    const anchor = $(element);
    const label = anchor.text().replace(/\s+/g, ' ').trim();
    const href = anchor.attr('href');
    if (!label) { anchor.remove(); return; }
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) { anchor.replaceWith(label); return; }
    try {
      const resolved = baseUrl ? new URL(href, baseUrl).toString() : href;
      anchor.replaceWith(`${label} (${resolved})`);
    } catch { anchor.replaceWith(label); }
  });

  const lines: string[] = [];
  root.find('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,dt,dd,tr').each((_index, element) => {
    const node = $(element);
    const tag = element.tagName.toLowerCase();
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const heading = tag.match(/^h([1-6])$/);
    if (heading) lines.push(`${'#'.repeat(Number(heading[1]))} ${text}`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else if (tag === 'tr') lines.push(text);
    else lines.push(text);
  });
  const readable = lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return readable || root.text().replace(/\s+/g, ' ').trim();
}
