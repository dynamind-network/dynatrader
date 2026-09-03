import { BaseTool, ToolKind } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';

export class WebFetchTool extends BaseTool {
  name = 'web_fetch';
  description =
    'Fetch content from a URL. Uses Firecrawl API if FIRECRAWL_API_KEY is set for better scraping, otherwise uses native fetch.';
  isDestructive = false;
  readOnly = true;
  canRunInParallel = false;
  searchHint = 'fetch url retrieve webpage content';
  kind = ToolKind.Fetch;

  inputSchema = {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      maxLength: {
        type: 'number',
        description:
          'Maximum characters to return (default: 8000). Content will be truncated if exceeds this limit.',
      },
    },
    required: ['url'],
  };

  private getFirecrawlKey(): string | undefined {
    return process.env.FIRECRAWL_API_KEY;
  }

  private isPrivateIP(host: string): boolean {
    try {
      const ip = host.replace(/^\[|\]$/g, '');
      if (ip === 'localhost' || ip.startsWith('127.')) return true;
      if (ip.startsWith('10.')) return true;
      if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return true;
      }
      if (ip.startsWith('192.168.')) return true;
      if (ip.startsWith('169.254.')) return true;
      if (ip.startsWith('0.0.0.0') || ip === '::1' || ip.startsWith('fe80:')) return true;
      if (host.includes('metadata.google.internal')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const url = input.url as string;
    const maxLength = (input.maxLength as number) || 8000;

    if (!url || url.trim().length === 0) {
      return this.error('URL is required');
    }

    try {
      new URL(url);
    } catch {
      return this.error('Invalid URL format');
    }

    try {
      const parsedUrl = new URL(url);
      if (this.isPrivateIP(parsedUrl.hostname)) {
        return this.error('Cannot fetch URLs pointing to private IP addresses');
      }
    } catch {
      return this.error('Invalid URL');
    }

    const firecrawlKey = this.getFirecrawlKey();

    if (firecrawlKey) {
      return this.fetchWithFirecrawl(url, maxLength, firecrawlKey);
    } else {
      return this.fetchNative(url, maxLength);
    }
  }

  private async fetchWithFirecrawl(
    url: string,
    maxLength: number,
    apiKey: string
  ): Promise<ToolResult> {
    try {
      const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url: url,
          formats: ['markdown', 'html', 'text'],
          onlyMainContent: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return this.error(`Firecrawl failed: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        data?: {
          markdown?: string;
          html?: string;
          text?: string;
        };
      };

      const content = data.data?.markdown || data.data?.text || data.data?.html || '';

      let truncated = false;
      let displayContent = content;

      if (content.length > maxLength) {
        displayContent = content.substring(0, maxLength) + '\n... [truncated]';
        truncated = true;
      }

      const output = [
        `<url>${url}</url>`,
        `<provider>Firecrawl</provider>`,
        `<status>success</status>`,
        truncated ? `<truncated>true</truncated>` : '',
        '<content>',
        displayContent,
        '</content>',
      ].join('\n');

      return this.success(output);
    } catch (err) {
      return this.handleError(err, 'Firecrawl fetch failed');
    }
  }

  private async fetchNative(url: string, maxLength: number): Promise<ToolResult> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'DynaMind/1.0',
          Accept: 'text/html,application/json,text/plain,*/*',
        },
      });

      if (!response.ok) {
        return this.error(`Fetch failed: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      let truncated = false;
      let displayContent = text;

      if (text.length > maxLength) {
        displayContent = text.substring(0, maxLength) + '\n... [truncated]';
        truncated = true;
      }

      const output = [
        `<url>${url}</url>`,
        `<status>${response.status}</status>`,
        `<contentType>${contentType}</contentType>`,
        truncated ? `<truncated>true</truncated>` : '',
        '<content>',
        displayContent,
        '</content>',
      ].join('\n');

      return this.success(output);
    } catch (err) {
      return this.handleError(err, 'Web fetch failed');
    }
  }
}
