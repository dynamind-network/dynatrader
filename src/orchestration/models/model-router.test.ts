import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '@dyna/contracts';
import { ModelRouterImpl } from './model-router';
import { AuditTrail } from '@dyna/audit';
import { CircuitState } from './circuit-breaker';

// --- Mock AuditTrail ---
vi.mock('@dyna/audit', () => {
  const mockRecord = vi.fn().mockResolvedValue(undefined);
  return {
    AuditTrail: vi.fn().mockImplementation(() => ({
      record: mockRecord,
      getEvents: vi.fn().mockResolvedValue([]),
      searchEvents: vi.fn().mockResolvedValue([]),
      getEventSummary: vi.fn().mockResolvedValue({ totalEvents: 0 }),
    })),
  };
});

// --- Mock providers for testing ---
function createMockProvider(id: string, name: string, shouldFail = false): ModelProvider {
  return {
    id,
    name,
    async call(request: ModelRequest): Promise<ModelResponse> {
      if (shouldFail) {
        throw new Error(`Provider ${id} failed`);
      }
      return {
        content: `Response from ${id}`,
        model: request.model ?? `${id}-model`,
        provider: id,
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
        latencyMs: 100,
      };
    },
  };
}

describe('ModelRouterImpl', () => {
  let router: ModelRouterImpl;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new ModelRouterImpl({ workspacePath: '/tmp/test-audit' });
  });

  describe('provider registration', () => {
    it('should register and retrieve providers', () => {
      const provider = createMockProvider('test-provider', 'Test Provider');
      router.registerProvider(provider);

      const retrieved = router.getProvider('test-provider');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test-provider');
      expect(retrieved!.name).toBe('Test Provider');
    });

    it('should resolve context windows from active and explicit model ids', () => {
      const openai = createMockProvider('openai', 'OpenAI');
      const anthropic = createMockProvider('anthropic', 'Anthropic');

      router.registerProvider(openai);
      router.registerProvider(anthropic);

      expect(router.getContextWindowTokens?.('openai/gpt-4o-mini')).toBe(128000);
      expect(router.getContextWindowTokens?.('anthropic/claude-3-5-sonnet-20241022')).toBe(200000);
      expect(router.getContextWindowTokens?.('openrouter/anthropic/claude-3.5-sonnet')).toBe(200000);
      expect(router.getContextWindowTokens?.('custom-32k-model')).toBe(32000);
      expect(router.getContextWindowTokens?.('auto')).toBe(200000);
    });

    it('should handle empty provider registry', async () => {
      await expect(router.selectProvider('trading')).rejects.toThrow('No providers registered');
      await expect(router.call({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(
        'No providers registered',
      );
    });
  });

  describe('provider selection', () => {
    it('should select provider by configured provider order for non-critical work', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      const ollama = createMockProvider('ollama', 'Ollama');

      router.registerProvider(openai);
      router.registerProvider(ollama);

      const researchProvider = await router.selectProvider('research');
      expect(researchProvider.id).toBe('openai');

      const tradingProvider = await router.selectProvider('trading');
      expect(tradingProvider.id).toBe('openai');
    });

    it('should prefer anthropic for high risk tasks', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      const anthropic = createMockProvider('anthropic', 'Anthropic');

      router.registerProvider(openai);
      router.registerProvider(anthropic);

      const provider = await router.selectProvider('trading', 'high');
      expect(provider.id).toBe('anthropic');
    });

    it('should return first provider for any non-critical task when no override is set', async () => {
      const anthropic = createMockProvider('anthropic', 'Anthropic');
      router.registerProvider(anthropic);

      const provider = await router.selectProvider('unknown-task');
      expect(provider.id).toBe('anthropic');
    });
  });

  describe('calling providers', () => {
    it('should call a provider and return response', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      router.registerProvider(openai);

      const response = await router.call({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Response from openai');
      expect(response.provider).toBe('openai');
      expect(response.usage).toBeDefined();
      expect(response.usage.totalTokens).toBe(30);
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('aborts without falling back to another provider', async () => {
      const controller = new AbortController();
      const abortedProvider: ModelProvider = {
        id: 'openai', name: 'OpenAI',
        async call(request) {
          await new Promise<void>((_, reject) => request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
          throw new Error('unreachable');
        },
      };
      const fallback = createMockProvider('ollama', 'Ollama');
      const fallbackCall = vi.spyOn(fallback, 'call');
      router.registerProvider(abortedProvider);
      router.registerProvider(fallback);

      const pending = router.call({ messages: [{ role: 'user', content: 'cancel' }], signal: controller.signal }, 'trading');
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(fallbackCall).not.toHaveBeenCalled();
    });

    it('should handle provider errors gracefully', async () => {
      const failing = createMockProvider('failing', 'Failing Provider', true);
      router.registerProvider(failing);

      await expect(
        router.call({ messages: [{ role: 'user', content: 'test' }] }),
      ).rejects.toThrow('All providers exhausted');
    });
  });

  describe('fallback behavior', () => {
    it('should fallback to next provider on failure', async () => {
      const failing = createMockProvider('openai', 'OpenAI', true);
      const fallingBack = createMockProvider('anthropic', 'Anthropic');

      router.registerProvider(failing);
      router.registerProvider(fallingBack);

      const response = await router.call({
        messages: [{ role: 'user', content: 'test' }],
        model: 'test-model',
      });

      // Should have fallen back to anthropic
      expect(response.content).toBe('Response from anthropic');
      expect(response.provider).toBe('anthropic');
    });

    it('should throw when all providers fail', async () => {
      const fail1 = createMockProvider('openai', 'OpenAI', true);
      const fail2 = createMockProvider('anthropic', 'Anthropic', true);

      router.registerProvider(fail1);
      router.registerProvider(fail2);

      await expect(
        router.call({ messages: [{ role: 'user', content: 'test' }] }),
      ).rejects.toThrow('All providers exhausted');
    });
  });

  describe('cost tracking', () => {
    it('should track cost and token usage', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      router.registerProvider(openai);

      await router.call({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const stats = await router.getCostStats();
      expect(stats.totalTokens).toBe(30);
      expect(stats.totalCost).toBeGreaterThan(0);
      expect(stats.callsByProvider['openai']).toBe(1);
    });

    it('should return cost statistics', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      const anthropic = createMockProvider('anthropic', 'Anthropic');
      router.registerProvider(openai);
      router.registerProvider(anthropic);

      await router.call({ messages: [{ role: 'user', content: 'Hello' }] }, 'trading');
      await router.call({ messages: [{ role: 'user', content: 'Analyze' }] }, 'research');

      const stats = await router.getCostStats();
      expect(typeof stats.totalCost).toBe('number');
      expect(stats.totalTokens).toBe(60);
      expect(Object.keys(stats.callsByProvider).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('auditing', () => {
    it('should audit all model calls', async () => {
      const openai = createMockProvider('openai', 'OpenAI');
      router.registerProvider(openai);

      await router.call({
        messages: [{ role: 'user', content: 'audit me' }],
      });

      const auditTrailMock = AuditTrail as any;
      const mockInstance = auditTrailMock.mock.results[0]?.value;
      expect(mockInstance.record).toHaveBeenCalledTimes(1);

      const recordCall = mockInstance.record.mock.calls[0]?.[0];
      expect(recordCall.type).toBe('model_call');
      expect(recordCall.actor).toBe('model-router');
      expect(recordCall.result).toBe('success');
      expect(recordCall.action).toBe('model_call:openai');
    });

    it('should audit failed model calls', async () => {
      const failing = createMockProvider('openai', 'OpenAI', true);
      router.registerProvider(failing);

      await expect(
        router.call({ messages: [{ role: 'user', content: 'fail' }] }),
      ).rejects.toThrow();

      const auditTrailMock = AuditTrail as any;
      const mockInstance = auditTrailMock.mock.results[0]?.value;
      expect(mockInstance.record).toHaveBeenCalled();
    });
  });

  describe('circuit breaker integration', () => {
    it('should start circuit breakers in CLOSED state for registered providers', () => {
      const openai = createMockProvider('openai', 'OpenAI');
      router.registerProvider(openai);

      const states = router.getCircuitStates();
      expect(states).toHaveLength(1);
      expect(states[0]!.providerId).toBe('openai');
      expect(states[0]!.state).toBe(CircuitState.CLOSED);
      expect(states[0]!.failureCount).toBe(0);
    });

    it('should open circuit breaker after repeated failures', async () => {
      const failing = createMockProvider('openai', 'OpenAI', true);
      router.registerProvider(failing);

      // Make multiple calls that will fail
      for (let i = 0; i < 5; i++) {
        await expect(
          router.call({ messages: [{ role: 'user', content: 'test' }] }),
        ).rejects.toThrow();
      }

      const states = router.getCircuitStates();
      const openaiState = states.find((s) => s.providerId === 'openai');
      expect(openaiState).toBeDefined();
      expect(openaiState!.state).toBe(CircuitState.OPEN);
      expect(openaiState!.failureCount).toBe(5);
    });

    it('should create circuit breaker with custom config', () => {
      const routerWithConfig = new ModelRouterImpl({
        workspacePath: '/tmp/test-audit',
        circuitBreakerConfig: { errorThreshold: 2, resetTimeoutMs: 10000 },
      });
      const provider = createMockProvider('openai', 'OpenAI');
      routerWithConfig.registerProvider(provider);

      const states = routerWithConfig.getCircuitStates();
      expect(states).toHaveLength(1);
      expect(states[0]!.state).toBe(CircuitState.CLOSED);
    });

    it('should skip open-circuited providers and fallback to others', async () => {
      // Register only a failing provider first, trip its circuit
      const failing = createMockProvider('openai', 'OpenAI', true);
      router.registerProvider(failing);

      // Fail enough times to open the circuit
      for (let i = 0; i < 5; i++) {
        await expect(
          router.call({ messages: [{ role: 'user', content: 'test' }] }),
        ).rejects.toThrow();
      }

      // Now openai circuit should be open
      let states = router.getCircuitStates();
      expect(states).toHaveLength(1);
      expect(states[0]!.state).toBe(CircuitState.OPEN);

      // Now register a working provider
      const working = createMockProvider('anthropic', 'Anthropic');
      router.registerProvider(working);

      // openai circuit is open, so it should be skipped and anthropic should handle the call
      const response = await router.call({ messages: [{ role: 'user', content: 'hello' }] });
      expect(response.provider).toBe('anthropic');
    });

    it('should open circuit after threshold failures and record circuit state', async () => {
      const failProvider = createMockProvider('failme', 'Fail Me', true);
      const router2 = new ModelRouterImpl({
        workspacePath: '/tmp/test-audit',
        circuitBreakerConfig: { errorThreshold: 3 },
      });
      router2.registerProvider(failProvider);

      // Fail below threshold - should stay CLOSED
      for (let i = 0; i < 2; i++) {
        await expect(
          router2.call({ messages: [{ role: 'user', content: 'test' }] }),
        ).rejects.toThrow();
      }
      expect(router2.getCircuitStates()[0]!.state).toBe(CircuitState.CLOSED);
      expect(router2.getCircuitStates()[0]!.failureCount).toBe(2);

      // One more failure should open the circuit
      await expect(
        router2.call({ messages: [{ role: 'user', content: 'test' }] }),
      ).rejects.toThrow();

      const states = router2.getCircuitStates();
      expect(states[0]!.state).toBe(CircuitState.OPEN);
      expect(states[0]!.failureCount).toBe(3);
    });
  });
});
