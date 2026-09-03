import { getErrorMessage } from '../../utils/index.js';
import { parseJson } from '../../utils/json.js';
import { AIProvider } from './base-provider.js';
import { PROVIDERS } from './registry.js';
import type { ChatMessage, ChatRequest, ChatResponse, ProviderConfig, ToolCall } from './types.js';
import { mapFinishReason } from './types.js';
import { appendWithOverlap } from './utils.js';

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIReasoningDelta {
  reasoning_content?: string;
}

export class OpenAICompatibleProvider extends AIProvider {
  private providerName: string;

  constructor(providerName: string, apiKey: string) {
    const existing = PROVIDERS[providerName as keyof typeof PROVIDERS];
    const config: ProviderConfig = existing
      ? { ...existing, apiKey }
      : { name: providerName, displayName: providerName, apiKey, env: [], models: [], defaultModel: '' };
    super(config);
    this.providerName = providerName;
  }

  private buildToolChoice(toolChoice: ChatRequest['toolChoice']): 'auto' | 'required' {
    return toolChoice === 'required' ? 'required' : 'auto';
  }

  private finalizeToolCalls(
    pendingToolCalls: Array<{
      id: string;
      name: string;
      argumentsText: string;
    }>
  ): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const pending of pendingToolCalls) {
      if (!pending.name) {
        continue;
      }

      try {
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          arguments: pending.argumentsText ? (parseJson(pending.argumentsText) ?? {}) : {},
        });
      } catch {
        continue;
      }
    }

    return toolCalls;
  }

  private parseToolResultContent(content: string): Array<{
    type: string;
    tool_use_id: string;
    content: string;
  }> {
    if (content.startsWith('[{')) {
      return (
        parseJson<Array<{ type: string; tool_use_id: string; content: string }>>(content) ?? []
      );
    }

    const toolResults: Array<{
      type: string;
      tool_use_id: string;
      content: string;
    }> = [];

    const toolResultMatches = content.match(/\[{"type":"tool_result"[^\]]*\]/g);
    if (toolResultMatches) {
      for (const match of toolResultMatches) {
        const parsed =
          parseJson<Array<{ type: string; tool_use_id: string; content: string }>>(match);
        if (parsed) {
          toolResults.push(...parsed);
        }
      }
    }

    return toolResults;
  }

  private parseAssistantContent(content: string): {
    textParts: string[];
    toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  } {
    const blocks =
      parseJson<
        Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>
      >(content) ?? [];

    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    return { textParts, toolCalls };
  }

  private transformMessages(
    messages: ChatMessage[],
    systemPrompt?: string
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'user' && msg.content.includes('tool_result')) {
        const toolResults = this.parseToolResultContent(msg.content);
        for (const resultItem of toolResults) {
          if (resultItem.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: resultItem.tool_use_id,
              content: resultItem.content,
            });
          }
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.content.startsWith('[{')) {
        try {
          const { textParts, toolCalls } = this.parseAssistantContent(msg.content);
          const assistantMsg: Record<string, unknown> = {
            role: 'assistant',
            content: textParts.join('\n') || null,
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          result.push(assistantMsg);
          continue;
        } catch {
          // Fall through to default handling
        }
      }

      result.push({ role: msg.role, content: msg.content });
    }

    return result;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.transformMessages(request.messages, request.systemPrompt);

    const tools = request.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = this.buildToolChoice(request.toolChoice);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check for insufficient balance (402) or quota exceeded errors
      if (
        response.status === 402 ||
        errorText.includes('Insufficient Balance') ||
        errorText.includes('insufficient_quota')
      ) {
        const providerName = this.displayName.toLowerCase();
        let rechargeUrl = '';

        if (providerName.includes('deepseek')) {
          rechargeUrl = 'https://platform.deepseek.com/';
        } else if (providerName.includes('openai')) {
          rechargeUrl = 'https://platform.openai.com/account/billing';
        } else if (providerName.includes('anthropic')) {
          rechargeUrl = 'https://console.anthropic.com/settings/billing';
        } else if (providerName.includes('google')) {
          rechargeUrl = 'https://console.cloud.google.com/billing';
        }

        const errorMessage = [
          `Insufficient credits for ${this.displayName}`,
          '',
          'Your API key has run out of credits.',
          rechargeUrl ? `Please recharge at: ${rechargeUrl}` : 'Please recharge your account.',
          '',
          'Original error: ' + errorText,
        ].join('\n');

        throw new Error(errorMessage);
      }

      throw new Error(`${this.displayName} API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    };

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = [];
    const thinking = choice.message.reasoning_content ? [choice.message.reasoning_content] : [];

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: parseJson(tc.function.arguments) ?? {},
        });
      }
    }

    return {
      content: choice.message.content || '',
      thinking,
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    };
  }

  async chatStream(request: ChatRequest, onPartial: (text: string) => void): Promise<ChatResponse> {
    const messages = this.transformMessages(request.messages, request.systemPrompt);

    const tools = request.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = this.buildToolChoice(request.toolChoice);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check for insufficient balance (402) or quota exceeded errors
      if (
        response.status === 402 ||
        errorText.includes('Insufficient Balance') ||
        errorText.includes('insufficient_quota')
      ) {
        const providerName = this.displayName.toLowerCase();
        let rechargeUrl = '';

        if (providerName.includes('deepseek')) {
          rechargeUrl = 'https://platform.deepseek.com/';
        } else if (providerName.includes('openai')) {
          rechargeUrl = 'https://platform.openai.com/account/billing';
        } else if (providerName.includes('anthropic')) {
          rechargeUrl = 'https://console.anthropic.com/settings/billing';
        } else if (providerName.includes('google')) {
          rechargeUrl = 'https://console.cloud.google.com/billing';
        }

        const errorMessage = [
          `Insufficient credits for ${this.displayName}`,
          '',
          'Your API key has run out of credits.',
          rechargeUrl ? `Please recharge at: ${rechargeUrl}` : 'Please recharge your account.',
          '',
          'Original error: ' + errorText,
        ].join('\n');

        throw new Error(errorMessage);
      }

      throw new Error(`${this.displayName} API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for streaming');
    }

    const decoder = new TextDecoder();
    let content = '';
    let reasoning = '';
    const pendingToolCalls: Array<{
      id: string;
      name: string;
      argumentsText: string;
    }> = [];
    let buffer = '';
    let finishReason: ChatResponse['stopReason'] = 'end_turn';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = parseJson<{
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: OpenAIToolCallDelta[];
                };
                finish_reason?: string;
              }>;
            }>(data);

            if (!chunk) continue;

            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) {
              content = appendWithOverlap(content, choice.delta.content);
              onPartial(content);
            }

            if (choice?.delta?.reasoning_content) {
              reasoning = appendWithOverlap(reasoning, choice.delta.reasoning_content);
            }

            if (choice?.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const index = tc.index ?? pendingToolCalls.length;
                if (!pendingToolCalls[index]) {
                  pendingToolCalls[index] = {
                    id: '',
                    name: '',
                    argumentsText: '',
                  };
                }

                if (tc.id) {
                  pendingToolCalls[index].id = tc.id;
                }
                if (tc.function?.name) {
                  pendingToolCalls[index].name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  pendingToolCalls[index].argumentsText += tc.function.arguments;
                }
              }
            }

            if (choice?.finish_reason === 'tool_calls') {
              finishReason = 'tool_use';
            } else if (choice?.finish_reason === 'length') {
              finishReason = 'max_tokens';
            }
          } catch (err) {
            console.warn('[Providers] Failed to parse response metadata:', getErrorMessage(err));
          }
        }
      }
    }

    const toolCalls = this.finalizeToolCalls(pendingToolCalls);

    if (toolCalls.length > 0 && finishReason === 'end_turn') {
      finishReason = 'tool_use';
    }

    return {
      content,
      thinking: reasoning ? [reasoning] : [],
      toolCalls,
      stopReason: finishReason,
      usage: {
        inputTokens: 0,
        outputTokens: content.length / 4,
      },
    };
  }
}
