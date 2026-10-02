import { OpenAICompatibleProvider } from './openai.js';

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    super('openrouter', apiKey);
  }
}

