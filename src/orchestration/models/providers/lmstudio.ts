import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk, ToolDefinition } from '@dyna/contracts';
import { resolveProviderModelId } from './model-utils';

export interface LMStudioProviderConfig {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export class LMStudioProvider implements ModelProvider {
  readonly id = 'lmstudio';
  readonly name = 'LM Studio';

  private model: string;
  private resolvedModel: string | null = null;
  private baseUrl: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config?: LMStudioProviderConfig) {
    this.model = config?.model ?? process.env['LM_STUDIO_MODEL'] ?? '';
    this.baseUrl = config?.baseUrl ?? process.env['LM_STUDIO_BASE_URL'] ?? 'http://localhost:1234';
    this.maxTokens = config?.maxTokens ?? 8192;
    this.temperature = config?.temperature ?? 0.7;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const model = await this.resolveModel(request.model);
    const response = await this.sendChatCompletion(request, model);
    return this.parseResponse(response, startTime);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const model = await this.resolveModel(request.model);
    const body = this.buildRequestBody(request, model);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`LM Studio API streaming error ${response.status}: ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('LM Studio API streaming response body is null');
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
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const parsed = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield { type: 'content' as const, content: delta };
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
   * LM Studio is a local provider - cost is always $0.
   */
  static calculateCost(_model: string, _promptTokens: number, _completionTokens: number): number {
    return 0;
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

  private async sendChatCompletion(request: ModelRequest, model: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildRequestBody(request, model)),
        signal: request.signal,
      });
    } catch (err) {
      throw new Error(`LM Studio API request failed: ${(err as Error).message}`);
    }
  }

  private parseResponse(response: Response, startTime: number): Promise<ModelResponse> {
    if (!response.ok) {
      return response.text().then((errorBody) => {
        throw new Error(`LM Studio API error ${response.status}: ${errorBody || 'Unknown error'}`);
      });
    }

    return response.json().then((data) => {
      const payload = data as {
        model: string;
        choices: Array<{
          message: {
            content: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const message = payload.choices?.[0]?.message;
      let content = message?.content?.trim() ?? '';
      let toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        type: tc.type as 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
      const promptTokens = payload.usage?.prompt_tokens ?? 0;
      const completionTokens = payload.usage?.completion_tokens ?? 0;
      const totalTokens = payload.usage?.total_tokens ?? 0;

      // LM Studio bug workaround (issue #1602): when the "separate
      // reasoning_content" toggle is ON, the model sometimes puts ALL
      // output in reasoning_content and leaves content empty, while
      // also emitting tool_calls for tools that may not exist. The
      // model did real work — it's trapped in reasoning_content.
      // Use it as content and discard the tool_calls so the consumer
      // sees the model's actual reasoning instead of a tool error.
      const hasReasoning = Boolean(message?.reasoning_content?.trim());
      const hasContent = Boolean(content);
      const hasToolCalls = Boolean(toolCalls && toolCalls.length > 0);
      if (!hasContent && hasReasoning && hasToolCalls) {
        content = message!.reasoning_content!.trim();
        toolCalls = undefined;
      }

      return {
        content,
        reasoningContent: message?.reasoning_content ?? undefined,
        model: payload.model,
        provider: this.id,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        latencyMs: Date.now() - startTime,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      };
    });
  }

  private async resolveModel(requestedModel?: string): Promise<string> {
    const candidate = resolveProviderModelId(this.id, requestedModel, this.model);
    if (candidate) {
      this.resolvedModel = candidate;
      return candidate;
    }

    if (this.resolvedModel) {
      return this.resolvedModel;
    }

    const discovered = await this.discoverModelFromServer();
    if (discovered) {
      this.resolvedModel = discovered;
      return discovered;
    }

    throw new Error(
      `LM Studio has no valid model configured. Set LM_STUDIO_MODEL or load a model in LM Studio at ${this.baseUrl}.`,
    );
  }

  private async discoverModelFromServer(): Promise<string | null> {
    const endpoints = [`${this.baseUrl}/v1/models`, `${this.baseUrl}/api/v1/models`];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) continue;
        const payload = await response.json().catch(() => null) as
          | { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }
          | null;
        const models = payload?.data ?? payload?.models ?? [];
        const firstValid = models.find((entry) => typeof entry?.id === 'string' && entry.id.trim().length > 0)?.id?.trim();
        if (firstValid) {
          return firstValid;
        }
      } catch {
        // Try the next endpoint.
      }
    }
    return null;
  }

}
