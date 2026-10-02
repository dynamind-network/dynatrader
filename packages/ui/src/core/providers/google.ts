import { AIProvider } from './base-provider.js';
import { PROVIDERS } from './registry.js';
import type { ChatRequest, ChatResponse, ToolCall } from './types.js';
import { mapFinishReason } from './types.js';
import { appendWithOverlap } from './utils.js';

export class GoogleProvider extends AIProvider {
  constructor(apiKey: string) {
    const config = { ...PROVIDERS.google, apiKey };
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const contents = this.buildContents(request);

    const tools =
      request.tools && request.tools.length > 0
        ? {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (tools) body.tools = tools;
    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    const model = request.model || 'gemini-2.5-flash';
    const response = await fetch(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      stopReason: mapFinishReason(candidate?.finishReason || 'STOP'),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  async chatStream(request: ChatRequest, onPartial: (text: string) => void): Promise<ChatResponse> {
    const contents = this.buildContents(request);

    const tools =
      request.tools && request.tools.length > 0
        ? {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (tools) body.tools = tools;
    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    const model = request.model || 'gemini-2.5-flash';
    const response = await fetch(
      `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let content = '';
    const toolCalls: ToolCall[] = [];
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> };
            }>;
          };
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              content = appendWithOverlap(content, part.text);
              onPartial(content);
            }
            if (part.functionCall) {
              toolCalls.push({
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args as Record<string, unknown>,
              });
            }
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    return {
      content,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private buildContents(request: ChatRequest): Array<{ role: string; parts: Array<{ text: string }> }> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') continue;
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
    return contents;
  }
}

