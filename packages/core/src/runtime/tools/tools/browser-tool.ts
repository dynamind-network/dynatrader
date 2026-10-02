import type { Page } from 'playwright';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import { BrowserSessionStore } from './browser-session';

export interface BrowserToolConfig {
  defaultTimeout?: number;
  maxTimeout?: number;
  sessionStore?: BrowserSessionStore;
  userDataDir?: string;
  headless?: boolean;
}

type BrowserAction = 'goto' | 'screenshot' | 'click' | 'fill' | 'evaluate' | 'content' | 'waitForSelector';

/** Playwright-backed browser automation with persistent, named sessions. */
export class BrowserTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'browser',
    description: 'Control a persistent browser session: navigate, inspect, interact, and capture screenshots',
    category: 'browser',
    inputSchema: {
      action: 'string (goto|screenshot|click|fill|evaluate|content|waitForSelector)',
      url: 'string?', selector: 'string?', value: 'string?', expression: 'string?',
      sessionId: 'string?', timeout: 'number?', fullPage: 'boolean?',
    },
    outputSchema: { action: 'string', url: 'string?', title: 'string?', content: 'string?', screenshotBase64: 'string?', mimeType: 'string?', result: 'unknown?' },
    permissionsRequired: ['tool.browser'],
    sideEffects: ['network_access'],
    riskLevel: 'medium',
    readOnly: false,
    timeoutMs: 30000,
  };

  private readonly defaultTimeout: number;
  private readonly maxTimeout: number;
  private readonly sessions: BrowserSessionStore;

  constructor(config: BrowserToolConfig = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 15_000;
    this.maxTimeout = config.maxTimeout ?? 60_000;
    this.sessions = config.sessionStore ?? new BrowserSessionStore({ userDataDir: config.userDataDir, headless: config.headless });
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    const args = call.args;
    const action = (args.action as BrowserAction | undefined) ?? 'goto';
    const sessionId = (args.sessionId as string | undefined)?.trim() || 'default';
    const timeout = this.clampTimeout(args.timeout);
    try {
      if (!['goto', 'screenshot', 'click', 'fill', 'evaluate', 'content', 'waitForSelector'].includes(action)) {
        return this.failure(`Unsupported browser action: ${String(action)}`, startedAt);
      }
      if (action === 'goto') {
        const url = this.requireUrl(args.url);
        const page = await this.sessions.getPage(sessionId);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        return this.success(await this.describePage(page, action), startedAt);
      }
      if (action === 'click' || action === 'waitForSelector') this.requireString(args.selector, 'selector');
      if (action === 'fill') {
        this.requireString(args.selector, 'selector');
        this.requireString(args.value, 'value');
      }
      if (action === 'evaluate') this.requireString(args.expression, 'expression');
      const page = await this.sessions.getPage(sessionId);
      page.setDefaultTimeout(timeout);
      switch (action) {
        case 'screenshot': {
          const bytes = await page.screenshot({ fullPage: args.fullPage === true, type: 'png' });
          return this.success({ action, url: page.url(), title: await page.title(), screenshotBase64: bytes.toString('base64'), mimeType: 'image/png' }, startedAt);
        }
        case 'click':
          await page.locator(this.requireString(args.selector, 'selector')).click();
          return this.success(await this.describePage(page, action), startedAt);
        case 'fill':
          await page.locator(this.requireString(args.selector, 'selector')).fill(this.requireString(args.value, 'value'));
          return this.success(await this.describePage(page, action), startedAt);
        case 'evaluate': {
          const expression = this.requireString(args.expression, 'expression');
          const result = await page.evaluate((source) => (0, eval)(source), expression);
          return this.success({ action, url: page.url(), result }, startedAt);
        }
        case 'content':
          return this.success({ action, url: page.url(), title: await page.title(), content: await page.content() }, startedAt);
        case 'waitForSelector':
          await page.locator(this.requireString(args.selector, 'selector')).waitFor({ state: 'visible', timeout });
          return this.success({ action, url: page.url(), selector: args.selector }, startedAt);
      }
    } catch (error) {
      return this.failure(this.normalizeError(error), startedAt);
    }
  }

  async closeSession(sessionId?: string): Promise<void> { await this.sessions.close(sessionId); }

  private async describePage(page: Page, action: BrowserAction): Promise<Record<string, unknown>> {
    return { action, url: page.url(), title: await page.title(), content: await page.locator('body').innerText().catch(() => '') };
  }

  private requireUrl(value: unknown): string {
    const url = this.requireString(value, 'url');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are supported.`);
    return parsed.toString();
  }

  private requireString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
    return value;
  }

  private clampTimeout(value: unknown): number {
    const requested = typeof value === 'number' && Number.isFinite(value) ? value : this.defaultTimeout;
    return Math.max(100, Math.min(requested, this.maxTimeout));
  }

  private success(data: Record<string, unknown>, startedAt: number): ToolResult { return { success: true, data, durationMs: Date.now() - startedAt, truncated: false }; }
  private failure(error: string, startedAt: number): ToolResult { return { success: false, error, durationMs: Date.now() - startedAt, truncated: false }; }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Executable doesn't exist") || message.includes('browserType.launch')
      ? `${message}. Install the Playwright browser with: bunx playwright install chromium`
      : message;
  }
}
