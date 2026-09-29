import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk, ToolDefinition } from '@dyna/contracts';
import { resolveProviderModelId } from './model-utils';

/**
 * Cost per 1K tokens in USD for OpenAI models (input, output)
 */
const OPENAI_MODEL_COSTS: Record<string, [number, number]> = {
  'gpt-4o': [0.0025, 0.01],
  'gpt-4o-2024-08-06': [0.0025, 0.01],
  'gpt-4o-mini': [0.00015, 0.0006],
  'gpt-4o-mini-2024-07-18': [0.00015, 0.0006],
  'gpt-4-turbo': [0.01, 0.03],
  'gpt-4': [0.03, 0.06],
  'gpt-4-32k': [0.06, 0.12],
  'gpt-3.5-turbo': [0.0005, 0.0015],
  'gpt-3.5-turbo-0125': [0.0005, 0.0015],
};

export interface OpenAIProviderConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string = 'openai';
  readonly name: string = 'OpenAI';

  private model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config?: OpenAIProviderConfig) {
    const key = config?.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!key) {
      throw new Error('OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass apiKey in config.');
    }
    this.apiKey = key;
    this.model = config?.model ?? 'gpt-4o-mini';
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com/v1';
    this.maxTokens = config?.maxTokens ?? 4096;
    this.temperature = config?.temperature ?? 0.7;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const model = resolveProviderModelId(this.id, request.model, this.model);

    const body = this.buildRequestBody(request, model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw new Error(`OpenAI API request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as {
      model: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const message = data.choices?.[0]?.message;
    const content = message?.content ?? '';
    const toolCalls = message?.tool_calls?.map(tc => ({
      id: tc.id,
      type: tc.type as 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const totalTokens = data.usage?.total_tokens ?? 0;

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
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const model = resolveProviderModelId(this.id, request.model, this.model);
    const body = this.buildRequestBody(request, model);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI API streaming error ${response.status}: ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('OpenAI API streaming response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const parsed = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              }; finish_reason?: string | null }>;
            };
            const choice = parsed.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) {
              yield { type: 'content' as const, content: delta };
            }
            for (const toolDelta of choice?.delta?.tool_calls ?? []) {
              const current = pendingToolCalls.get(toolDelta.index) ?? { id: '', name: '', arguments: '' };
              if (toolDelta.id) current.id = toolDelta.id;
              if (toolDelta.function?.name) current.name += toolDelta.function.name;
              if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
              pendingToolCalls.set(toolDelta.index, current);
            }
            if (choice?.finish_reason) {
              for (const toolCall of [...pendingToolCalls.values()]) {
                if (toolCall.id && toolCall.name) {
                  yield { type: 'tool_call' as const, toolCall: {
                    id: toolCall.id,
                    type: 'function' as const,
                    function: { name: toolCall.name, arguments: toolCall.arguments || '{}' },
                  } };
                }
              }
              pendingToolCalls.clear();
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
    const pricing = OPENAI_MODEL_COSTS[model] ?? [0.002, 0.002]; // fallback pricing
    const inputCost = (promptTokens / 1000) * pricing[0];
    const outputCost = (completionTokens / 1000) * pricing[1];
    return inputCost + outputCost;
  }

  private buildRequestBody(request: ModelRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature ?? this.temperature,
    };

    if (request.stop && request.stop.length > 0) {
      body['stop'] = request.stop;
    }

    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map(t => {
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [key, val] of Object.entries(t.inputSchema ?? {})) {
          const strVal = String(val);
          const isOptional = strVal.endsWith('?');
          const typeName = isOptional ? strVal.slice(0, -1) : strVal;
          properties[key] = { type: typeName === 'any' ? 'string' : typeName };
          if (!isOptional) required.push(key);
        }
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: {
              type: 'object',
              properties,
              ...(required.length > 0 ? { required } : {}),
            },
          },
        };
      });
    }

    return body;
  }
}
