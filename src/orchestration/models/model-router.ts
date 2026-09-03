import type { ModelProvider, ModelRequest, ModelResponse, ModelRouter, ModelStreamChunk } from '@dyna/contracts';
import { AuditTrail } from '@dyna/audit';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { CircuitBreaker, CircuitState, type CircuitBreakerConfig } from './circuit-breaker';

const PROVIDER_DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
  openrouter: 128_000,
  deepseek: 128_000,
  google: 1_000_000,
  ollama: 8_192,
  lmstudio: 8_192,
};

const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /gpt-4o(?:-[\w-]+)?/i, tokens: 128_000 },
  { pattern: /gpt-4-turbo/i, tokens: 128_000 },
  { pattern: /gpt-4-32k/i, tokens: 32_768 },
  { pattern: /gpt-4\b/i, tokens: 8_192 },
  { pattern: /gpt-3\.5-turbo(?:-[\w-]+)?/i, tokens: 16_385 },
  { pattern: /claude-4-sonnet/i, tokens: 200_000 },
  { pattern: /claude-3[.-]5-sonnet/i, tokens: 200_000 },
  { pattern: /claude-3[.-]5-haiku/i, tokens: 200_000 },
  { pattern: /claude-3-sonnet/i, tokens: 200_000 },
  { pattern: /claude-3-haiku/i, tokens: 200_000 },
  { pattern: /claude-3-opus/i, tokens: 200_000 },
  { pattern: /gemini-2\.5-(flash|pro)/i, tokens: 1_000_000 },
  { pattern: /gemini-1\.5-(flash|pro)/i, tokens: 2_000_000 },
  { pattern: /deepseek-(chat|r1)/i, tokens: 128_000 },
  { pattern: /llama-3(?:\.\d+)?(?:-instruct)?(?:-8b|-70b)?/i, tokens: 8_192 },
];

export interface ModelRouterConfig {
  auditTrail?: AuditTrail;
  workspacePath?: string;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
}

interface CostEntry {
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  timestamp: number;
}

export class ModelRouterImpl implements ModelRouter {
  private providers: Map<string, ModelProvider> = new Map();
  private auditTrail?: AuditTrail;
  private costHistory: CostEntry[] = [];
  private activeModelOverride: string | null = null;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private circuitConfig?: Partial<CircuitBreakerConfig>;

  constructor(config?: ModelRouterConfig) {
    if (config?.auditTrail) {
      this.auditTrail = config.auditTrail;
    } else if (config?.workspacePath) {
      this.auditTrail = new AuditTrail(config.workspacePath);
    }

    this.circuitConfig = config?.circuitBreakerConfig;
  }

  /**
   * Register a model provider.
   */
  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
    this.circuitBreakers.set(provider.id, new CircuitBreaker(provider.id, this.circuitConfig));
  }

  /**
   * Switch the active model override. The modelId format is "provider/model"
   * (e.g., "openai/gpt-4o"). All subsequent calls will use this provider
   * directly until resetModel() is called.
   */
  switchModel(modelId: string): { switched: boolean; previousModel: string; newModel: string } {
    const [providerId] = modelId.split('/');
    if (!this.providers.has(providerId)) {
      throw new Error(`Provider "${providerId}" is not registered. Available providers: ${Array.from(this.providers.keys()).join(', ')}`);
    }

    const previousModel = this.activeModelOverride ?? 'auto';
    this.activeModelOverride = modelId;

    return {
      switched: true,
      previousModel,
      newModel: modelId,
    };
  }

  /**
   * Returns the current active model override, or "auto" if none set.
   */
  getActiveModel(): string {
    return this.activeModelOverride ?? 'auto';
  }

  getContextWindowTokens(modelId?: string): number | undefined {
    const resolved = resolveModelContextWindow(modelId, this.getOrderedProviders());
    return resolved?.contextWindowTokens;
  }

  /**
   * Returns all available models from all registered providers.
   */
  listModels(): Array<{ id: string; provider: string; supportsStreaming: boolean }> {
    const models: Array<{ id: string; provider: string; supportsStreaming: boolean }> = [];

    for (const [id, provider] of this.providers) {
      models.push({
        id: provider.id,
        provider: provider.id,
        supportsStreaming: !!provider.stream,
      });
    }

    return models;
  }

  /**
   * Clears the activeModelOverride, returning to task-based routing.
   */
  resetModel(): void {
    this.activeModelOverride = null;
  }

  /**
   * Select the best provider based on risk level and configured provider order.
   *
   * Route logic:
   * - High risk / critical -> prefer Anthropic, then OpenAI, then the first available provider
   * - All other work -> use the first registered provider unless the active model override is set
   *
   * Provider order is the default routing policy. Task strings are accepted for
   * compatibility but do not encode hidden persona-specific behavior here.
   */
  async selectProvider(task: string, riskLevel?: string): Promise<ModelProvider> {
    const providers = this.getOrderedProviders();

    if (providers.length === 0) {
      throw new Error('No providers registered. Call registerProvider() before selecting a provider.');
    }

    // High-risk tasks get the most reliable provider regardless of task type
    if (riskLevel === 'high' || riskLevel === 'critical') {
      const anthropic = this.providers.get('anthropic');
      if (anthropic) return anthropic;

      const openai = this.providers.get('openai');
      if (openai) return openai;

      return providers[0] as ModelProvider;
    }

    // Non-critical work follows provider order. This keeps routing workspace-driven
    // instead of embedding task-persona heuristics in the runtime.
    return providers[0] as ModelProvider;
  }

  /**
   * Call a provider with the given request, selecting the best provider for the task.
   * On failure, falls back to the next available provider.
   */
  async call(request: ModelRequest, task?: string): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError');
    const providers = this.getOrderedProviders();
    if (providers.length === 0) {
      throw new Error('No providers registered. Call registerProvider() before making a call.');
    }

    // Hot model override: use the specified provider directly
    if (this.activeModelOverride) {
      const [providerId] = this.activeModelOverride.split('/');
      const overrideProvider = this.providers.get(providerId);
      if (overrideProvider) {
        const reqWithModel = { ...request, model: this.activeModelOverride };
        return this.callWithFallback(overrideProvider, reqWithModel, []);
      }
    }

    // If no task specified, use the first available provider directly
    if (!task) {
      return this.callWithFallback(providers[0] as ModelProvider, request, []);
    }

    // Select primary provider based on risk level and provider order.
    const riskLevel = request.model === 'claude-3-opus-20240229' ? 'high' : 'low';
    const primary = await this.selectProvider(task, riskLevel);

    // Attempt call with fallback chain
    return this.callWithFallback(primary, request, []);
  }

  /**
   * Stream a model response with the given request, selecting the best provider for the task.
   * On failure, falls back to the next available provider.
   */
  async *stream(request: ModelRequest, task?: string): AsyncIterable<ModelStreamChunk> {
    if (request.signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError');
    const providers = this.getOrderedProviders();
    if (providers.length === 0) {
      throw new Error('No providers registered. Call registerProvider() before streaming.');
    }

    // Hot model override: use the specified provider directly
    if (this.activeModelOverride) {
      const [providerId] = this.activeModelOverride.split('/');
      const overrideProvider = this.providers.get(providerId);
      if (overrideProvider) {
        const reqWithModel = { ...request, model: this.activeModelOverride };
        yield* this.streamWithFallback(overrideProvider, reqWithModel, []);
        return;
      }
    }

    // If no task specified, use the first available provider directly
    if (!task) {
      yield* this.streamWithFallback(providers[0] as ModelProvider, request, []);
      return;
    }

    // Select primary provider based on risk level and provider order.
    const riskLevel = request.model === 'claude-3-opus-20240229' ? 'high' : 'low';
    const primary = await this.selectProvider(task, riskLevel);

    // Attempt stream with fallback chain
    yield* this.streamWithFallback(primary, request, []);
  }

  /**
   * Attempt streaming with automatic fallback to other providers.
   */
  private async *streamWithFallback(
    primary: ModelProvider,
    request: ModelRequest,
    attempted: string[],
  ): AsyncIterable<ModelStreamChunk> {
    if (request.signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError');
    const candidates = [
      primary,
      ...this.getOrderedProviders().filter((p) => p.id !== primary.id),
    ].filter((provider, index, self) => self.findIndex((item) => item.id === provider.id) === index);
    const provider = candidates.find((item) => !attempted.includes(item.id));

    if (!provider) {
      throw new Error('All providers exhausted. No providers available to handle the request.');
    }

    attempted.push(provider.id);

    // Check circuit breaker before attempting the call
    const cb = this.circuitBreakers.get(provider.id);
    if (cb && !cb.allowRequest()) {
      // Circuit is open, skip this provider and try the next one
      yield* this.streamWithFallback(primary, request, attempted);
      return;
    }

    // Check if provider supports streaming
    if (!provider.stream) {
      // Fallback: use non-streaming call and wrap result
      try {
        const response = await provider.call(request);
        const cost = this.calculateCost(provider.id, response.model, response.usage.promptTokens, response.usage.completionTokens);
        this.costHistory.push({
          providerId: provider.id,
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          cost,
          timestamp: Date.now(),
        });
        await this.auditCall(provider, request, response, 'success');
        cb?.recordSuccess();

        // Yield content as a single chunk
        if (response.content) {
          yield { type: 'content', content: response.content };
        }
        // Yield tool calls
        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            yield { type: 'tool_call', toolCall: tc };
          }
        }
        yield { type: 'done', usage: response.usage };
        return;
      } catch (error) {
        await this.auditCall(provider, request, undefined, 'failure', (error as Error).message);
        const errorMessage = (error as Error).message;
        const category = this.inferErrorCategory(errorMessage);
        cb?.recordFailure(category);
        // Attempt fallback
        yield* this.streamWithFallback(primary, request, attempted);
        return;
      }
    }

    // Provider supports streaming - delegate to it
    try {
      let lastChunk: ModelStreamChunk | undefined;
      for await (const chunk of provider.stream!(request)) {
        lastChunk = chunk;
        yield chunk;
      }

      // Track cost from final usage if available
      if (lastChunk?.usage) {
        const cost = this.calculateCost(provider.id, request.model ?? 'unknown', lastChunk.usage.promptTokens, lastChunk.usage.completionTokens);
        this.costHistory.push({
          providerId: provider.id,
          model: request.model ?? 'unknown',
          promptTokens: lastChunk.usage.promptTokens,
          completionTokens: lastChunk.usage.completionTokens,
          totalTokens: lastChunk.usage.totalTokens,
          cost,
          timestamp: Date.now(),
        });
      }

      await this.auditStream(provider, request, 'success');
      cb?.recordSuccess();
    } catch (error) {
      await this.auditStream(provider, request, 'failure', (error as Error).message);
      const errorMessage = (error as Error).message;
      const category = this.inferErrorCategory(errorMessage);
      cb?.recordFailure(category);
      // Attempt fallback to next provider
      yield* this.streamWithFallback(primary, request, attempted);
    }
  }

  /**
   * Audit a streaming call via AuditTrail.
   */
  private async auditStream(
    provider: ModelProvider,
    request: ModelRequest,
    result: 'success' | 'failure' = 'success',
    errorMessage?: string,
  ): Promise<void> {
    if (!this.auditTrail) return;

    const details: Record<string, unknown> = {
      provider: provider.id,
      model: request.model,
      messageCount: request.messages.length,
      streaming: true,
    };

    if (errorMessage) {
      details['error'] = errorMessage;
    }

    await this.auditTrail.record({
      type: 'model_call',
      actor: 'model-router',
      actorType: 'system',
      action: `model_stream:${provider.id}`,
      resource: request.model ?? 'unknown',
      result: result === 'success' ? 'success' : 'failure',
      details,
    });
  }

  /**
   * Get a provider by its id.
   */
  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get cost statistics across all providers.
   */
  async getCostStats(): Promise<{
    totalCost: number;
    totalTokens: number;
    callsByProvider: Record<string, number>;
  }> {
    const callsByProvider: Record<string, number> = {};

    let totalCost = 0;
    let totalTokens = 0;

    for (const entry of this.costHistory) {
      totalCost += entry.cost;
      totalTokens += entry.totalTokens;
      callsByProvider[entry.providerId] = (callsByProvider[entry.providerId] ?? 0) + 1;
    }

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTokens,
      callsByProvider,
    };
  }

  /**
   * Attempt a model call with automatic fallback to other providers.
   */
  private async callWithFallback(
    primary: ModelProvider,
    request: ModelRequest,
    attempted: string[],
  ): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError');
    const candidates = [
      primary,
      ...this.getOrderedProviders().filter((p) => p.id !== primary.id),
    ].filter((provider, index, self) => self.findIndex((item) => item.id === provider.id) === index);
    const provider = candidates.find((item) => !attempted.includes(item.id));

    if (!provider) {
      throw new Error('All providers exhausted. No providers available to handle the request.');
    }

    attempted.push(provider.id);

    // Check circuit breaker before attempting the call
    const cb = this.circuitBreakers.get(provider.id);
    if (cb && !cb.allowRequest()) {
      // Circuit is open, skip this provider and try the next one
      return this.callWithFallback(primary, request, attempted);
    }

    try {
      const response = await provider.call(request);
      cb?.recordSuccess();
      const cost = this.calculateCost(provider.id, response.model, response.usage.promptTokens, response.usage.completionTokens);

      this.costHistory.push({
        providerId: provider.id,
        model: response.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        cost,
        timestamp: Date.now(),
      });

      await this.auditCall(provider, request, response, 'success');

      return response;
    } catch (error) {
      await this.auditCall(provider, request, undefined, 'failure', (error as Error).message);
      // Record failure in circuit breaker (category from error message if available)
      const errorMessage = (error as Error).message;
      const category = this.inferErrorCategory(errorMessage);
      cb?.recordFailure(category);

      if (request.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }

      // Attempt fallback to next provider
      return this.callWithFallback(primary, request, attempted);
    }
  }

  /**
   * Audit a model call via AuditTrail.
   */
  private async auditCall(
    provider: ModelProvider,
    request: ModelRequest,
    response?: ModelResponse,
    result: 'success' | 'failure' = 'success',
    errorMessage?: string,
  ): Promise<void> {
    if (!this.auditTrail) return;

    const details: Record<string, unknown> = {
      provider: provider.id,
      model: request.model,
      messageCount: request.messages.length,
    };

    if (response) {
      details['tokenUsage'] = response.usage;
      details['latencyMs'] = response.latencyMs;
    }

    if (errorMessage) {
      details['error'] = errorMessage;
    }

    await this.auditTrail.record({
      type: 'model_call',
      actor: 'model-router',
      actorType: 'system',
      action: `model_call:${provider.id}`,
      resource: request.model ?? 'unknown',
      result: result === 'success' ? 'success' : 'failure',
      details,
    });
  }

  /**
   * Get circuit breaker states for all registered providers.
   */
  getCircuitStates(): Array<{ providerId: string; state: CircuitState; failureCount: number; openedAt: number | null }> {
    return Array.from(this.circuitBreakers.entries()).map(([id, cb]) => ({
      providerId: id,
      state: cb.getState(),
      failureCount: cb.getStateInfo().failureCount,
      openedAt: cb.getStateInfo().openedAt,
    }));
  }

  /**
   * Infer the error category from an error message.
   */
  private inferErrorCategory(errorMessage: string): string | undefined {
    const lower = errorMessage.toLowerCase();
    if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key')) {
      return 'auth';
    }
    if (lower.includes('fatal')) {
      return 'fatal';
    }
    if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429')) {
      return 'rate_limit';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return 'timeout';
    }
    return undefined;
  }

  /**
   * Calculate cost for a model call using provider-specific calculation.
   */
  private calculateCost(
    providerId: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number {
    if (providerId === 'openai') {
      return OpenAIProvider.calculateCost(model, promptTokens, completionTokens);
    }

    if (providerId === 'anthropic') {
      return AnthropicProvider.calculateCost(model, promptTokens, completionTokens);
    }

    // Ollama and others are free / unknown
    return 0;
  }

  /**
   * Get providers in priority order (reliable first).
   */
  private getOrderedProviders(): ModelProvider[] {
    const priority = ['anthropic', 'openai', 'openrouter', 'google', 'deepseek', 'lmstudio', 'ollama'];
    const ordered: ModelProvider[] = [];

    for (const id of priority) {
      const provider = this.providers.get(id);
      if (provider) {
        ordered.push(provider);
      }
    }

    // Add any remaining providers not in priority list
    for (const [id, provider] of this.providers) {
      if (!priority.includes(id)) {
        ordered.push(provider);
      }
    }

    return ordered;
  }
}

function resolveModelContextWindow(
  modelId: string | undefined,
  orderedProviders: ModelProvider[],
): { providerId: string; model: string; contextWindowTokens?: number } | undefined {
  if (orderedProviders.length === 0) {
    return undefined;
  }

  const parsed = parseModelId(modelId);
  const candidateProviderId = parsed?.providerId ?? orderedProviders[0]!.id;
  const candidateModel = parsed?.model ?? defaultModelForProvider(candidateProviderId) ?? '';

  return {
    providerId: candidateProviderId,
    model: candidateModel,
    contextWindowTokens: inferContextWindowTokens(candidateProviderId, candidateModel),
  };
}

function parseModelId(modelId: string | undefined): { providerId: string; model: string } | undefined {
  if (!modelId || modelId === 'auto') {
    return undefined;
  }

  const slashIndex = modelId.indexOf('/');
  if (slashIndex === -1) {
    return { providerId: '', model: modelId };
  }

  return {
    providerId: modelId.slice(0, slashIndex).trim(),
    model: modelId.slice(slashIndex + 1).trim(),
  };
}

function defaultModelForProvider(providerId: string): string | undefined {
  switch (providerId) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-2.5-flash';
    case 'deepseek':
      return 'deepseek-chat';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    case 'ollama':
    case 'lmstudio':
      return undefined;
    default:
      return undefined;
  }
}

function inferContextWindowTokens(providerId: string, model: string): number | undefined {
  const normalizedModel = model.toLowerCase();

  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (entry.pattern.test(normalizedModel)) {
      return entry.tokens;
    }
  }

  const numericHint = extractContextWindowHint(normalizedModel);
  if (numericHint) {
    return numericHint;
  }

  return PROVIDER_DEFAULT_CONTEXT_WINDOWS[providerId.toLowerCase()];
}

function extractContextWindowHint(model: string): number | undefined {
  const match = model.match(/(\d{1,3}(?:,\d{3})+|\d+)(k|m)\b/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const suffix = match[2].toLowerCase();
  if (suffix === 'm') {
    return value * 1_000_000;
  }
  if (suffix === 'k') {
    return value * 1_000;
  }
  return undefined;
}
