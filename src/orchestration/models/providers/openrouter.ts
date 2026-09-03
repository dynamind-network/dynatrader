import { OpenAIProvider } from './openai';

export interface OpenRouterProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

/** OpenRouter exposes an OpenAI-compatible API for its model catalogue. */
export class OpenRouterProvider extends OpenAIProvider {
  override readonly id = 'openrouter';
  override readonly name = 'OpenRouter';

  constructor(config: OpenRouterProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env['OPENROUTER_API_KEY'];
    if (!apiKey) throw new Error('OpenRouter API key not found. Set OPENROUTER_API_KEY.');
    super({
      apiKey,
      model: config.model ?? process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini',
      baseUrl: config.baseUrl ?? process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1',
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
  }
}
