import { OpenAICompatibleProvider } from './openai.js';

export class NVIDIAProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    super('nvidia', apiKey);
  }
}
