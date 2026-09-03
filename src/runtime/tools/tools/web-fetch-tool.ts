import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

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

      const format = (call.args.format as string | undefined) ?? 'markdown';
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

        if (rawContent.length > this.maxResponseLength) {
          return {
            success: true,
            data: {
              content: rawContent.slice(0, this.maxResponseLength) + '\n... [truncated]',
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
            content: rawContent,
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
