import { OpenAICompatibleProvider } from './openai.js';

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    super('ollama', apiKey || 'not-needed');
  }
}

