import { AIProvider } from './base-provider.js';
import { PROVIDERS } from './registry.js';
import type { ChatRequest, ChatResponse, ToolCall } from './types.js';
import { appendWithOverlap, appendUniqueToolCall } from './utils.js';

export class AnthropicProvider extends AIProvider {
  private client: any;

  constructor(apiKey: string) {
    const config = { ...PROVIDERS.anthropic, apiKey };
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey });
    }

    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
    });

    const toolCalls: ToolCall[] = [];
    let content = '';
    const thinking: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        const text = 'thinking' in block ? block.thinking : '';
        if (text) thinking.push(text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      thinking,
      toolCalls,
      stopReason:
        response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'end_turn',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async chatStream(request: ChatRequest, onPartial: (text: string) => void): Promise<ChatResponse> {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey });
    }

    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const stream = await this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
    });

    const toolCalls: ToolCall[] = [];
    let content = '';
    const thinking: string[] = [];
    let sawTextDelta = false;

    for await (const event of stream) {
      if (event.type === 'content-block-delta' && event.delta.type === 'text-delta') {
        sawTextDelta = true;
        content = appendWithOverlap(content, event.delta.text);
        onPartial(content);
      } else if (event.type === 'tool-use') {
        appendUniqueToolCall(toolCalls, {
          id: event.id,
          name: event.name,
          arguments: event.input as Record<string, unknown>,
        });
      }
    }

    const finalMessage = await stream.finalMessage();

    for (const block of finalMessage.content) {
      if (block.type === 'text') {
        if (!sawTextDelta) {
          content += block.text;
        }
      } else if (block.type === 'thinking') {
        const text = 'thinking' in block ? block.thinking : '';
        if (text) thinking.push(text);
      } else if (block.type === 'tool_use') {
        appendUniqueToolCall(toolCalls, {
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      thinking,
      toolCalls,
      stopReason:
        finalMessage.stop_reason === 'tool_use'
          ? 'tool_use'
          : finalMessage.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'end_turn',
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
    };
  }
}

