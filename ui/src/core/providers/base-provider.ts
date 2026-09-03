import type { ProviderConfig, ChatRequest, ChatResponse } from './types.js';

export abstract class AIProvider {
  // CRITICAL: Use private backing field to prevent API key exposure via
  // JSON.stringify, console.log, or error serialization
  #apiKey: string;
  protected get apiKey(): string {
    return this.#apiKey;
  }
  protected baseUrl: string;
  public readonly name: string;
  public readonly displayName: string;
  public models: ProviderConfig['models'];

  constructor(config: ProviderConfig) {
    this.#apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || '';
    this.name = config.name;
    this.displayName = config.displayName;
    this.models = config.models;
  }

  /**
   * CRITICAL: Override toJSON to prevent API key leakage in serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      displayName: this.displayName,
      baseUrl: this.baseUrl,
      models: this.models,
      // apiKey intentionally omitted
    };
  }

  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract chatStream(
    request: ChatRequest,
    onPartial: (text: string) => void
  ): Promise<ChatResponse>;
}
