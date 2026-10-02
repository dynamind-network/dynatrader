import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

export interface BrowserSessionConfig {
  userDataDir?: string;
  headless?: boolean;
}

/** Owns persistent Playwright contexts so authenticated sessions survive turns. */
export class BrowserSessionStore {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly userDataDir: string;
  private readonly headless: boolean;

  constructor(config: BrowserSessionConfig = {}) {
    this.userDataDir = config.userDataDir ?? join(process.cwd(), '.dynatrader', 'browser-sessions');
    this.headless = config.headless ?? true;
  }

  async getPage(sessionId: string): Promise<Page> {
    const context = await this.getContext(sessionId);
    return context.pages()[0] ?? context.newPage();
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId) {
      const context = this.contexts.get(sessionId);
      this.contexts.delete(sessionId);
      await context?.close();
      return;
    }
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(contexts.map((context) => context.close()));
  }

  private async getContext(sessionId: string): Promise<BrowserContext> {
    const existing = this.contexts.get(sessionId);
    if (existing) return existing;
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
    const sessionDir = join(this.userDataDir, safeId);
    await mkdir(sessionDir, { recursive: true });
    const context = await chromium.launchPersistentContext(sessionDir, {
      headless: this.headless,
      acceptDownloads: false,
    });
    this.contexts.set(sessionId, context);
    return context;
  }
}
