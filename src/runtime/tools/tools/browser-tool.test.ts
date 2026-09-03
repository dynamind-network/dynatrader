import { describe, expect, it, vi } from 'vitest';
import { BrowserTool } from './browser-tool';

function fakePage(): any {
  const locator = {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    innerText: vi.fn(async () => 'rendered page text'),
  };
  return {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://example.com/next'),
    title: vi.fn(async () => 'Example'),
    locator: vi.fn(() => locator),
    screenshot: vi.fn(async () => Buffer.from('png-bytes')),
    content: vi.fn(async () => '<html>content</html>'),
    evaluate: vi.fn(async (callback: (source: string) => unknown, source: string) => callback(source)),
    setDefaultTimeout: vi.fn(),
    __locator: locator,
  };
}

describe('BrowserTool', () => {
  it('supports navigation and persistent session selection', async () => {
    const page = fakePage();
    const store = { getPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
    const tool = new BrowserTool({ sessionStore: store as never });

    const result = await tool.execute({ tool: 'browser', args: { action: 'goto', url: 'https://example.com', sessionId: 'operator' } });

    expect(result.success).toBe(true);
    expect(store.getPage).toHaveBeenCalledWith('operator');
    expect(page.goto).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect((result.data as Record<string, unknown>).content).toBe('rendered page text');
  });

  it('supports click, fill, evaluate, wait, content, and screenshots', async () => {
    const page = fakePage();
    const store = { getPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
    const tool = new BrowserTool({ sessionStore: store as never });

    expect((await tool.execute({ tool: 'browser', args: { action: 'click', selector: '#buy' } })).success).toBe(true);
    expect((await tool.execute({ tool: 'browser', args: { action: 'fill', selector: '#symbol', value: 'BTC/USDT' } })).success).toBe(true);
    const evaluated = await tool.execute({ tool: 'browser', args: { action: 'evaluate', expression: '1 + 1' } });
    expect((evaluated.data as Record<string, unknown>).result).toBe(2);
    expect((await tool.execute({ tool: 'browser', args: { action: 'waitForSelector', selector: '#ready' } })).success).toBe(true);
    expect((await tool.execute({ tool: 'browser', args: { action: 'content' } })).success).toBe(true);
    const screenshot = await tool.execute({ tool: 'browser', args: { action: 'screenshot', fullPage: true } });
    expect((screenshot.data as Record<string, unknown>).mimeType).toBe('image/png');
    expect((screenshot.data as Record<string, unknown>).screenshotBase64).toBe(Buffer.from('png-bytes').toString('base64'));
    expect(page.__locator.click).toHaveBeenCalledWith();
    expect(page.__locator.fill).toHaveBeenCalledWith('BTC/USDT');
    expect(page.__locator.waitFor).toHaveBeenCalled();
  });

  it('rejects invalid URLs and missing interaction arguments before opening a browser', async () => {
    const store = { getPage: vi.fn(), close: vi.fn(async () => undefined) };
    const tool = new BrowserTool({ sessionStore: store as never });

    const invalidUrl = await tool.execute({ tool: 'browser', args: { action: 'goto', url: 'file:///tmp/test' } });
    const missingSelector = await tool.execute({ tool: 'browser', args: { action: 'click' } });

    expect(invalidUrl.success).toBe(false);
    expect(invalidUrl.error).toContain('Only http and https');
    expect(missingSelector.success).toBe(false);
    expect(missingSelector.error).toContain('selector');
    expect(store.getPage).not.toHaveBeenCalled();
  });
});
