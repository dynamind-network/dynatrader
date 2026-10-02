import { describe, expect, it } from 'vitest';
import { formatFetchedContent } from './web-fetch-tool.js';

describe('formatFetchedContent', () => {
  it('extracts readable main content and links from HTML', () => {
    const content = formatFetchedContent(`
      <html><body><nav>Navigation noise</nav><main><h1>Market update</h1>
      <p>Prices moved <a href="https://example.com/data">higher</a>.</p>
      <script>secret noise</script></main><footer>Footer noise</footer></body></html>
    `, 'text/html; charset=utf-8', 'markdown');
    expect(content).toContain('# Market update');
    expect(content).toContain('higher (https://example.com/data)');
    expect(content).not.toContain('Navigation noise');
    expect(content).not.toContain('Footer noise');
  });

  it('pretty prints JSON responses and keeps raw HTML only when requested', () => {
    expect(formatFetchedContent('{"price":12}', 'application/json', 'text')).toContain('\n  "price": 12');
    expect(formatFetchedContent('<main>hi</main>', 'text/html', 'html')).toBe('<main>hi</main>');
  });
});
