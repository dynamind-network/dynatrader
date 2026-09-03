import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LMStudioProvider } from './lmstudio';

describe('LMStudioProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LM_STUDIO_BASE_URL'];
    delete process.env['LM_STUDIO_MODEL'];
  });

  describe('configuration', () => {
    it('should create with config', () => {
      const provider = new LMStudioProvider({
        model: 'local-model',
        maxTokens: 2048,
        temperature: 0.5,
      });

      expect(provider.id).toBe('lmstudio');
      expect(provider.name).toBe('LM Studio');
    });

    it('should create without any config (no API key required)', () => {
      const provider = new LMStudioProvider();
      expect(provider.id).toBe('lmstudio');
      expect(provider.name).toBe('LM Studio');
    });

    it('should use defaults when no config provided', () => {
      const provider = new LMStudioProvider();
      expect(provider.id).toBe('lmstudio');
      expect(provider.name).toBe('LM Studio');
    });

    it('should read env vars for base URL', () => {
      process.env['LM_STUDIO_BASE_URL'] = 'http://custom:5678';
      process.env['LM_STUDIO_MODEL'] = 'custom-model';
      const provider = new LMStudioProvider();
      expect(provider.id).toBe('lmstudio');
    });
  });

  describe('build request', () => {
    it('should send correct request format and parse response', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      // Mock fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'local-model',
            choices: [{ message: { content: 'Hello from local LLM!' } }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
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
      expect(callArg[0]).toBe('http://localhost:1234/v1/chat/completions');
      expect(callArg[1]?.method).toBe('POST');
      expect(callArg[1]?.headers).toBeDefined();

      const headers = callArg[1]?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      // No Authorization header for local LM Studio
      expect(headers['Authorization']).toBeUndefined();

      const body = JSON.parse(callArg[1]?.body as string) as Record<string, unknown>;
      expect(body.model).toBe('local-model');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
      expect(body.temperature).toBe(0.3);

      expect(response.content).toBe('Hello from local LLM!');
      expect(response.model).toBe('local-model');
      expect(response.provider).toBe('lmstudio');
      expect(response.usage.promptTokens).toBe(20);
      expect(response.usage.completionTokens).toBe(10);
      expect(response.usage.totalTokens).toBe(30);
    });

    it('should use custom baseUrl from config', async () => {
      const provider = new LMStudioProvider({
        model: 'test-model',
        baseUrl: 'http://custom-host:8080',
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'test-model',
            choices: [{ message: { content: 'Hello' } }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        text: () => Promise.resolve(''),
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);

      await provider.call({
        messages: [{ role: 'user', content: 'hi' }],
      });

      const callArg = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArg[0]).toBe('http://custom-host:8080/v1/chat/completions');
    });

    it('should strip provider-qualified model ids before calling LM Studio', async () => {
      const provider = new LMStudioProvider({
        model: 'microsoft/phi-4-mini-reasoning',
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'microsoft/phi-4-mini-reasoning',
            choices: [{ message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        text: () => Promise.resolve(''),
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);

      await provider.call({
        messages: [{ role: 'user', content: 'ping' }],
        model: 'lmstudio/microsoft/phi-4-mini-reasoning',
      });

      const callArg = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArg[1]?.body as string) as Record<string, unknown>;
      expect(body.model).toBe('microsoft/phi-4-mini-reasoning');
    });
  });

  describe('error handling', () => {
    it('should handle API errors', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      } as Response);

      await expect(
        provider.call({
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow('LM Studio API error 500: Internal Server Error');
    });

    it('should handle network errors (connection refused)', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:1234'),
      );

      await expect(
        provider.call({
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow('LM Studio API request failed: connect ECONNREFUSED 127.0.0.1:1234');
    });

    it('should handle malformed response', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON')),
        text: () => Promise.resolve('not json'),
      } as Response);

      await expect(
        provider.call({
          messages: [{ role: 'user', content: 'test' }],
        }),
      ).rejects.toThrow('Invalid JSON');
    });

    it('should handle empty content in response', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'local-model',
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

    it('should preserve reasoning content when the model omits final content', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'local-model',
            choices: [{
              message: {
                content: null,
                reasoning_content: 'Working through the answer.',
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        text: () => Promise.resolve(''),
      } as Response);

      const response = await provider.call({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.content).toBe('');
      expect(response.reasoningContent).toBe('Working through the answer.');
    });

    it('should handle missing choices array', async () => {
      const provider = new LMStudioProvider({ model: 'local-model' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'local-model',
            choices: [],
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

  describe('stream', () => {
    it('should be defined on the provider', () => {
      const provider = new LMStudioProvider();
      expect(typeof provider.stream).toBe('function');
    });
  });
});
