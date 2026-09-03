import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk, ToolDefinition } from '@dyna/contracts';
import { resolveProviderModelId } from './model-utils';

export interface GoogleProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

type GeminiPart = { text?: string; functionCall?: { name: string; args: Record<string, unknown> } };

/** Google Gemini provider using the official Generative Language REST API. */
export class GoogleProvider implements ModelProvider {
  readonly id = 'google';
  readonly name = 'Google Gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: GoogleProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('Google API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY.');
    this.apiKey = apiKey;
    this.model = config.model ?? process.env['GOOGLE_MODEL'] ?? process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
    this.baseUrl = (config.baseUrl ?? process.env['GOOGLE_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const model = resolveProviderModelId(this.id, request.model, this.model).replace(/^models\//, '');
    const response = await fetch(this.endpoint(model, 'generateContent'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(request)),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Google Gemini API error ${response.status}: ${await response.text().catch(() => 'Unknown error')}`);

    const data = await response.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map(part => part.text ?? '').join('').trim();
    const toolCalls = parts.flatMap((part, index) => part.functionCall ? [{
      id: `google-tool-${index}`,
      type: 'function' as const,
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
    }] : []);
    const usage = data.usageMetadata;
    return {
      content,
      reasoningContent: candidate?.reasoning_content ?? undefined,
      model: data.modelVersion ?? model,
      provider: this.id,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      latencyMs: Date.now() - started,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const model = resolveProviderModelId(this.id, request.model, this.model).replace(/^models\//, '');
    const response = await fetch(this.endpoint(model, 'streamGenerateContent'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(request)),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Google Gemini API streaming error ${response.status}: ${await response.text().catch(() => 'Unknown error')}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Google Gemini API streaming response body is null');
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
          if (!trimmed || trimmed.startsWith(':')) continue;
          const json = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          try {
            const data = JSON.parse(json) as GeminiResponse;
            for (const part of data.candidates?.[0]?.content?.parts ?? []) {
              if (part.text) yield { type: 'content', content: part.text };
              if (part.functionCall) yield {
                type: 'tool_call',
                toolCall: { id: `google-tool-${part.functionCall.name}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } },
              };
            }
          } catch { /* Ignore incomplete or non-JSON SSE lines. */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private endpoint(model: string, method: string): string {
    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const system = request.messages.filter(message => message.role === 'system').map(message => message.content ?? '').join('\n');
    const contents = request.messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content ?? '' }],
    }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: request.maxTokens ?? this.maxTokens, temperature: request.temperature ?? this.temperature, ...(request.stop?.length ? { stopSequences: request.stop } : {}) },
    };
    if (system) body['systemInstruction'] = { parts: [{ text: system }] };
    if (request.tools?.length) body['tools'] = [{ functionDeclarations: request.tools.map(tool => this.functionDeclaration(tool)) }];
    return body;
  }

  private functionDeclaration(tool: ToolDefinition): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(tool.inputSchema ?? {})) {
      const raw = String(value);
      const optional = raw.endsWith('?');
      const type = raw.replace(/\?$/, '').toUpperCase();
      properties[key] = { type: type === 'ANY' ? 'STRING' : type };
      if (!optional) required.push(key);
    }
    return { name: tool.name, description: tool.description, parameters: { type: 'OBJECT', properties, ...(required.length ? { required } : {}) } };
  }
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; reasoning_content?: string | null }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}
