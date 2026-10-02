import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from './openai';
import { MemorySearchTool } from '../../../runtime/tools/tools/memory-search-tool';

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up the env var for tests
    process.env['OPENAI_API_KEY'] = 'test-key';
  });

  describe('configuration', () => {
    it('should create with config', () => {
      const provider = new OpenAIProvider({
        model: 'gpt-4',
        maxTokens: 2048,
        temperature: 0.5,
      });

      expect(provider.id).toBe('openai');
      expect(provider.name).toBe('OpenAI');
    });

    it('should throw if no API key is available', () => {
      delete process.env['OPENAI_API_KEY'];
      expect(() => new OpenAIProvider()).toThrow('OPENAI_API_KEY');
    });

    it('should use provided apiKey over env var', () => {
      const provider = new OpenAIProvider({ apiKey: 'custom-key' });
      expect(provider.id).toBe('openai');
      // The key is private, but we can verify no error is thrown
    });

    it('should use defaults when no config provided', () => {
      const provider = new OpenAIProvider();
      expect(provider.id).toBe('openai');
      expect(provider.name).toBe('OpenAI');
    });
  });

  describe('build request', () => {
    it('should build request correctly', async () => {
      const provider = new OpenAIProvider({ model: 'gpt-4o-mini' });

      // Mock fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'gpt-4o-mini',
            choices: [{ message: { content: 'Hello, world!' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        text: () => Promise.resolve(''),
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);

      const response = await provider.call({
        messages: [{ role: 'user', content: 'Say hello' }],
        temperature: 0.3,
      });

      // Verify the request body
      const callArg = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArg[0]).toBe('https://api.openai.com/v1/chat/completions');
      expect(callArg[1]?.method).toBe('POST');
      expect(callArg[1]?.headers).toBeDefined();

      const headers = callArg[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');

      const body = JSON.parse(callArg[1]?.body as string) as Record<string, unknown>;
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
      expect(body.temperature).toBe(0.3);

      expect(response.content).toBe('Hello, world!');
      expect(response.model).toBe('gpt-4o-mini');
      expect(response.usage.promptTokens).toBe(10);
      expect(response.usage.completionTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it('preserves structured tool schemas for OpenAI-compatible providers', async () => {
      const provider = new OpenAIProvider({ model: 'gpt-4o-mini' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'Found 0 records.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        text: () => Promise.resolve(''),
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);

      const memoryTool = new MemorySearchTool({} as never).definition;
      await provider.call({
        messages: [{ role: 'user', content: 'Check my memory.' }],
        tools: [memoryTool],
      });

      const request = mockFetch.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(request.body as string) as {
        tools: Array<{ function: { parameters: { properties: Record<string, unknown>; required?: string[] } } }>;
      };
      const parameters = body.tools[0]!.function.parameters;
      expect(parameters.properties['action']).toEqual({ type: 'string', enum: ['search', 'list'] });
      expect(parameters.properties['scope']).toEqual({ type: 'string' });
      expect(parameters.required).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle API errors', async () => {
      const provider = new OpenAIProvider();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response);

      await expect(
        provider.call({
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow('OpenAI API error 401: Unauthorized');
    });

    it('should handle network errors', async () => {
      const provider = new OpenAIProvider();

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      await expect(
        provider.call({
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow('OpenAI API request failed: Network error');
    });

    it('should handle empty content in response', async () => {
      const provider = new OpenAIProvider();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'gpt-4o-mini',
            choices: [{ message: { content: null } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        text: () => Promise.resolve(''),
      } as Response);

      const response = await provider.call({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.content).toBe('');
    });
  });
});
