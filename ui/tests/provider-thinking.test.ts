import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/core/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/core/providers/openai.js';

describe('provider thinking extraction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts thinking blocks from anthropic non-stream responses', async () => {
    const provider = new AnthropicProvider('test-key') as AnthropicProvider & {
      client: { messages: { create: ReturnType<typeof vi.fn> } };
    };

    provider.client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            { type: 'thinking', thinking: 'Need to inspect the repository first.' },
            { type: 'text', text: 'I found the issue.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      },
    };

    const result = await provider.chat({ model: 'claude', messages: [] });

    expect(result.thinking).toEqual(['Need to inspect the repository first.']);
    expect(result.content).toBe('I found the issue.');
  });

  it('extracts thinking blocks from anthropic streaming final message', async () => {
    const provider = new AnthropicProvider('test-key') as AnthropicProvider & {
      client: { messages: { stream: ReturnType<typeof vi.fn> } };
    };

    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'content-block-delta',
          delta: { type: 'text-delta', text: 'Visible answer' },
        };
      },
      finalMessage: vi.fn().mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'Compare the provider-specific formats.' },
          { type: 'text', text: 'Visible answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 9 },
      }),
    };

    provider.client = {
      messages: {
        stream: vi.fn().mockResolvedValue(stream),
      },
    };

    const result = await provider.chatStream({ model: 'claude', messages: [] }, () => {});

    expect(result.thinking).toEqual(['Compare the provider-specific formats.']);
    expect(result.content).toBe('Visible answer');
  });

  it('extracts reasoning_content from openai-compatible responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Final answer',
              reasoning_content: 'First inspect the files, then render reasoning separately.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 18,
        },
      }),
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider('deepseek', 'test-key');
    const result = await provider.chat({ model: 'deepseek-reasoner', messages: [] });

    expect(result.thinking).toEqual(['First inspect the files, then render reasoning separately.']);
    expect(result.content).toBe('Final answer');
    globalThis.fetch = originalFetch;
  });
});
