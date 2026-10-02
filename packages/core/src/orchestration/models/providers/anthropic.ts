import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk } from '@dyna/contracts';
import { resolveProviderModelId } from './model-utils';

/**
 * Cost per 1K tokens in USD for Anthropic models (input, output)
 */
const ANTHROPIC_MODEL_COSTS: Record<string, [number, number]> = {
  'claude-3-opus-20240229': [0.015, 0.075],
  'claude-3-sonnet-20240229': [0.003, 0.015],
  'claude-3-haiku-20240307': [0.00025, 0.00125],
  'claude-3-5-sonnet-20241022': [0.003, 0.015],
  'claude-3-5-haiku-20241022': [0.0008, 0.004],
  'claude-4-sonnet-20250514': [0.003, 0.015],
};

export interface AnthropicProviderConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  private model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config?: AnthropicProviderConfig) {
    const key = config?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!key) {
      throw new Error('Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.');
    }
    this.apiKey = key;
    this.model = config?.model ?? 'claude-3-5-sonnet-20241022';
    this.baseUrl = config?.baseUrl ?? 'https://api.anthropic.com/v1';
    this.maxTokens = config?.maxTokens ?? 4096;
    this.temperature = config?.temperature ?? 0.7;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const model = resolveProviderModelId(this.id, request.model, this.model);

    const body = this.buildRequestBody(request, model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw new Error(`Anthropic API request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as {
      id: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content?.map((c) => c.text).join('') ?? '';
    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    const latencyMs = Date.now() - startTime;

    return {
      content,
      model: data.model,
      provider: this.id,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      latencyMs,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const model = resolveProviderModelId(this.id, request.model, this.model);
    const body = this.buildRequestBody(request, model);

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Anthropic API streaming error ${response.status}: ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Anthropic API streaming response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const parsed = JSON.parse(trimmed.slice(6)) as {
              type?: string;
              delta?: { text?: string };
            };
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield { type: 'content' as const, content: parsed.delta.text };
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Calculate cost in USD based on token usage and model pricing.
   */
  static calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = ANTHROPIC_MODEL_COSTS[model] ?? [0.003, 0.015]; // fallback to sonnet pricing
    const inputCost = (promptTokens / 1000) * pricing[0];
    const outputCost = (completionTokens / 1000) * pricing[1];
    return inputCost + outputCost;
  }

  private buildRequestBody(request: ModelRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages: request.messages,
      temperature: request.temperature ?? this.temperature,
    };

    if (request.stop && request.stop.length > 0) {
      body['stop_sequences'] = request.stop;
    }

    return body;
  }
}
