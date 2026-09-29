/** Typed decision-model seam for harness control-flow decisions. */
export type HarnessDecisionKind = 'recovery' | 'completion' | 'command-risk';

export interface HarnessDecisionRequest {
  kind: HarnessDecisionKind;
  state: Record<string, unknown>;
}

export interface HarnessDecisionResult {
  choice: string;
  confidence?: number;
  score?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface DecisionModelProvider {
  readonly name: string;
  evaluate(request: HarnessDecisionRequest, signal?: AbortSignal): Promise<HarnessDecisionResult>;
}

export type DecisionModelProviderFactory = (
  config: DecisionModelsConfig,
  env: NodeJS.ProcessEnv,
) => DecisionModelProvider | undefined;

const providerFactories = new Map<string, DecisionModelProviderFactory>();

export function registerDecisionModelProvider(name: string, factory: DecisionModelProviderFactory): void {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error('Decision-model provider name cannot be empty.');
  providerFactories.set(key, factory);
}

export function createDecisionModelProvider(
  config: DecisionModelsConfig,
  env: NodeJS.ProcessEnv = process.env,
): DecisionModelProvider | undefined {
  const name = config.provider?.trim().toLowerCase();
  const factory = name ? providerFactories.get(name) : undefined;
  return factory?.(config, env);
}

export interface DecisionModelsConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  features?: {
    recovery?: boolean;
    completion?: boolean;
    commandRisk?: boolean;
  };
}

interface JevAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  score?: number;
  noul?: number;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const choices = {
  recovery: {
    type: 'choice',
    instructions: 'Choose the single best next harness response to the observed tool failure or stall.',
    criteria: {
      retry_with_feedback: 'A bounded retry is useful after passing the exact failure to the coding model.',
      change_approach: 'The agent should try a different tool or method, not repeat the same action.',
      ask_user: 'Progress needs missing user input or an external decision.',
      stop: 'Stop this task because retrying is unlikely to help or risks more damage.',
    },
  },
  completion: {
    type: 'choice',
    instructions: 'Does the observed evidence support completion, require more verification, or require user input?',
    criteria: {
      complete: 'The requested outcome is supported by observed tool results and available checks.',
      verify_more: 'The agent should perform a relevant check or inspect its changes before claiming completion.',
      ask_user: 'The outcome cannot be completed safely or correctly without user input.',
    },
  },
  'command-risk': {
    type: 'score',
    instructions: 'Score the proposed shell action by its potential for destructive, credential-sensitive, external, or hard-to-reverse side effects.',
    criteria: ['Low and reversible', 'Material but recoverable', 'High impact or difficult to reverse'],
  },
} as const;

/** First adapter. It uses the typed System One REST contract without coupling the harness to Jev types. */
export class JevDecisionProvider implements DecisionModelProvider {
  readonly name = 'typesafe';
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'jev-latest',
    baseUrl = 'https://api.typesafe.ai/v1/systemone',
    private readonly timeoutMs = 5000,
  ) {
    const normalizedBase = baseUrl.replace(/\/$/, '');
    this.endpoint = normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/systemone`
      : new URL(normalizedBase).pathname === '/'
        ? `${normalizedBase}/v1/systemone`
        : normalizedBase;
  }

  async evaluate(request: HarnessDecisionRequest, signal?: AbortSignal): Promise<HarnessDecisionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Decision request timed out')), this.timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          state: request.state,
          questions: { decision: choices[request.kind] },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Decision provider returned HTTP ${response.status}`);
      const body = await response.json() as JevResponse;
      const answer = body.answers?.decision;
      if (!answer) throw new Error('Decision provider response did not contain answers.decision');
      const choice = request.kind === 'command-risk'
        ? (typeof answer.score === 'number' ? String(answer.score) : '')
        : answer.choice;
      if (!choice) throw new Error('Decision provider returned an invalid typed answer');
      return {
        choice,
        confidence: answer.confidence,
        score: answer.score,
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
        model: body.model ?? this.model,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

registerDecisionModelProvider('typesafe', (config, env) => {
  const apiKey = env[config.apiKeyEnv ?? 'TYPESAFE_API_KEY'];
  return apiKey
    ? new JevDecisionProvider(apiKey, config.model ?? 'jev-latest', config.baseUrl)
    : undefined;
});

export interface DecisionMetrics {
  calls: number;
  failures: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  byKind: Record<HarnessDecisionKind, number>;
  outcomes: Record<string, number>;
}

/** Bounded, advisory decisions. The harness remains the authority for execution and turn limits. */
export class HarnessDecisionController {
  private metrics: DecisionMetrics = {
    calls: 0, failures: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0,
    byKind: { recovery: 0, completion: 0, 'command-risk': 0 },
    outcomes: {},
  };

  constructor(
    private readonly provider: DecisionModelProvider | undefined,
    private readonly features: DecisionModelsConfig['features'] = {},
  ) {}

  async evaluate(request: HarnessDecisionRequest, signal?: AbortSignal): Promise<HarnessDecisionResult | undefined> {
    if (!this.provider || this.features?.[request.kind === 'command-risk' ? 'commandRisk' : request.kind] === false) return undefined;
    const started = Date.now();
    this.metrics.calls++;
    this.metrics.byKind[request.kind] = (this.metrics.byKind[request.kind] ?? 0) + 1;
    try {
      // Keep each decision payload small and prevent tool output from bloating decision calls.
      const result = await this.provider.evaluate({
        ...request,
        state: boundDecisionState(request.state),
      }, signal);
      this.metrics.inputTokens += result.inputTokens ?? 0;
      this.metrics.outputTokens += result.outputTokens ?? 0;
      const outcomeKey = `${request.kind}:${result.choice}`;
      this.metrics.outcomes[outcomeKey] = (this.metrics.outcomes[outcomeKey] ?? 0) + 1;
      return result;
    } catch {
      this.metrics.failures++;
      return undefined;
    } finally {
      this.metrics.latencyMs += Date.now() - started;
    }
  }

  getMetrics(): DecisionMetrics {
    return { ...this.metrics, byKind: { ...this.metrics.byKind }, outcomes: { ...this.metrics.outcomes } };
  }
}

function boundDecisionState(state: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(state);
  if (encoded.length <= 10_000) return state;
  return {
    payloadTruncated: true,
    excerpt: encoded.slice(0, 10_000),
  };
}
