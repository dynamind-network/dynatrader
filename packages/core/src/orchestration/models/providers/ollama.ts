import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk } from '@dyna/contracts';
import { resolveProviderModelId } from './model-utils';

export interface OllamaProviderConfig {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';

  private model: string;
  private baseUrl: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config?: OllamaProviderConfig) {
    this.model = config?.model ?? 'llama3.1';
    this.baseUrl = config?.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
    this.maxTokens = config?.maxTokens ?? 4096;
    this.temperature = config?.temperature ?? 0.7;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const model = resolveProviderModelId(this.id, request.model, this.model);

    const body = this.buildRequestBody(request, model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw new Error(`Ollama API request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as {
      model: string;
      message: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
      total_duration?: number;
    };

    const content = data.message?.content ?? '';
    const promptTokens = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;
    const totalTokens = promptTokens + completionTokens;

    const latencyMs = data.total_duration
      ? Math.round(data.total_duration / 1_000_000) // nanoseconds to ms
      : Date.now() - startTime;

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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama API streaming error ${response.status}: ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Ollama API streaming response body is null');
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
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as {
              message?: { content: string };
              done?: boolean;
            };
            if (parsed.message?.content) {
              yield { type: 'content' as const, content: parsed.message.content };
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
   * Ollama is a local provider - cost is always $0.
   */
  static calculateCost(_model: string, _promptTokens: number, _completionTokens: number): number {
    return 0;
  }

  private buildRequestBody(request: ModelRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      options: {
        num_predict: request.maxTokens ?? this.maxTokens,
        temperature: request.temperature ?? this.temperature,
      },
    };

    if (request.stop && request.stop.length > 0) {
      (body['options'] as Record<string, unknown>)['stop'] = request.stop;
    }

    return body;
  }
}
