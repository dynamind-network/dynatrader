import { describe, expect, it, vi } from 'vitest';
import { VisionTool } from './vision-tool';

describe('VisionTool', () => {
  it('sends a screenshot to a vision model', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'a chart' } }] }), { status: 200 }));
    const tool = new VisionTool({ apiKey: 'key', baseUrl: 'https://vision.test/v1', fetchImpl: fetchMock });
    const result = await tool.execute({ tool: 'vision_analyze', args: { imageBase64: 'abc', prompt: 'What is shown?' } });
    expect(result).toMatchObject({ success: true, data: { text: 'a chart' } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://vision.test/v1/chat/completions');
  });
});
