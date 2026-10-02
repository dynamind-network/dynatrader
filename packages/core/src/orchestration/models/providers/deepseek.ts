import { OpenAIProvider } from './openai';

export interface DeepSeekProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

/** DeepSeek's chat API is OpenAI-compatible. */
export class DeepSeekProvider extends OpenAIProvider {
  override readonly id = 'deepseek';
  override readonly name = 'DeepSeek';

  constructor(config: DeepSeekProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env['DEEPSEEK_API_KEY'];
    if (!apiKey) throw new Error('DeepSeek API key not found. Set DEEPSEEK_API_KEY.');
    super({
      apiKey,
      model: config.model ?? process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
      // Keep the native provider aligned with models.default.yaml and
      // DeepSeek's documented OpenAI-compatible base URL. OpenAIProvider
      // appends /chat/completions itself.
      baseUrl: config.baseUrl ?? process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
  }
}
