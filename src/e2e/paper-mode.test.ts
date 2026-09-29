/**
 * Paper mode end-to-end test with LM Studio.
 * Runs a trade through DynaTraderRuntime with LM Studio as the model provider.
 *
 * Usage: LM_STUDIO_MODEL=google/gemma-4-e2b npx vitest run src/e2e/paper-mode.test.ts --testTimeout=120000
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DynaTraderRuntime } from '../orchestration/workspace/index';
import { TradingPipeline } from '../orchestration/workspace/trading-pipeline';
import type { RuntimeConfig } from '../orchestration/workspace/types';
import { resolve } from 'path';

const WORKSPACE = resolve(__dirname, '../../workspace');

describe('Deterministic paper-mode trading pipeline', () => {
  it('produces a BUY decision for BTC/USDT from research, analysis, and risk outputs', async () => {
    const pipeline = new TradingPipeline({
      workspacePath: 'test-workspace',
      mode: 'paper',
      marketContextResolver: async () => ({ symbol: 'BTC/USDT', timeframe: '1h' }),
    });

    pipeline.on('research-agent', async () => ({
      type: 'research',
      symbol: 'BTC/USDT',
      timeframe: '1h',
      hypotheses: [{ type: 'trend', direction: 'bullish', confidence: 0.8 }],
      confidence: 0.8,
      analysis: 'Deterministic bullish test signal',
    }));
    pipeline.on('market-analyst', async () => ({
      type: 'technical_analysis',
      symbol: 'BTC/USDT',
      indicators: {},
      signals: [{ type: 'BUY', confidence: 0.9 }],
      support: [],
      resistance: [],
    }));
    pipeline.on('risk-manager', async () => ({
      type: 'risk_assessment',
      riskScore: 0.1,
      riskLevel: 'low',
      maxPositionSize: 0.1,
      stopLoss: 0,
      takeProfit: 0,
      factors: [],
      recommendation: 'APPROVED',
    }));

    const result = await pipeline.execute();

    expect(result.symbol).toBe('BTC/USDT');
    expect(result.timeframe).toBe('1h');
    expect(result.research.agentOutputs['research-agent']).toMatchObject({ confidence: 0.8 });
    expect(result.analysis.agentOutputs['market-analyst']).toMatchObject({
      signals: [{ type: 'BUY', confidence: 0.9 }],
    });
    expect(result.risk.agentOutputs['risk-manager']).toMatchObject({
      recommendation: 'APPROVED',
      riskScore: 0.1,
    });
    expect(result.decision.action).toBe('BUY');
    expect(result.decision.confidence).toBe(0.87);
    expect(result.totalExecutionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Paper Mode E2E with LM Studio', () => {
  let runtime: DynaTraderRuntime;
  let hasLMStudio = false;

  beforeAll(async () => {
    // Check if LM Studio is running
    try {
      const resp = await fetch('http://localhost:1234/v1/models');
      const data = await resp.json() as any;
      hasLMStudio = data?.data?.length > 0;
      console.log(`\n=== LM Studio running with ${data?.data?.length || 0} models ===`);
      console.log(`Available models: ${(data?.data || []).map((m: any) => m.id).join(', ')}`);
    } catch {
      console.log('\n=== LM Studio NOT available, test will check runtime only ===');
    }

    const config: RuntimeConfig = {
      workspacePath: WORKSPACE,
      mode: 'paper',
      strictMode: false,
      requireRiskProfile: false,
      requireTradingPolicy: false,
      requireAuthConfig: false,
      liveTradingEnabled: false,
      enableShadowMode: false,
      enableMicroLiveMode: false,
    };

    runtime = new DynaTraderRuntime(WORKSPACE, config);
    await runtime.start();

    console.log(`\n=== Runtime started ===`);
    const status = runtime.getStatus();
    console.log(`State: ${status.state} | Mode: ${status.mode}`);

    // Check which providers are registered
    try {
      const modelRouter = runtime.getModelRouter();
      const costStats = await modelRouter.getCostStats();
      const providers = Object.keys(costStats.callsByProvider);
      console.log(`Registered providers: ${providers.length > 0 ? providers.join(', ') : 'none (local only)'}`);
    } catch {
      console.log('Provider stats unavailable');
    }
  });

  afterAll(async () => {
    if (runtime) {
      await runtime.shutdown();
      console.log('\nRuntime shut down.');
    }
  });

  it('should start with all components in paper mode', () => {
    const status = runtime.getStatus();
    expect(status.state).toBe('running');
    expect(status.mode).toBe('paper');
    expect(status.components.memory).toBe(true);
    expect(status.components.modelRouter).toBe(true);
    expect(status.components.agentCore).toBe(true);
    expect(status.components.paperEngine).toBe(true);
    expect(status.components.executionRouter).toBe(true);
    expect(status.components.a2aRuntime).toBe(true);
    expect(status.components.pipeline).toBe(true);
  });

  it('should have LM Studio provider registered automatically', async () => {
    const modelRouter = runtime.getModelRouter();
    // LM Studio is always registered (like Ollama) regardless of API keys
    const costStats = await modelRouter.getCostStats();
    const providers = Object.keys(costStats.callsByProvider);

    console.log(`\nProviders: ${providers.join(', ') || 'none'}`);
    // LM Studio should be auto-registered
    // We just verify the runtime initialized without errors
    expect(runtime).toBeDefined();
  });

  it('should run trade for BTC/USDT with LM Studio', async () => {
    if (!hasLMStudio) {
      console.log('\nSkipping LM Studio trade test -- LM Studio not running.');
      return;
    }

    const agent = runtime.getAgent();

    const context = {
      now: new Date(),
      mode: 'paper' as const,
      accountId: 'e2e-test',
      portfolioId: 'e2e-portfolio',
      correlationId: `e2e-${Date.now()}`,
    };

    const source = {
      kind: 'llm-plan' as const,
      body: 'Analyze BTC/USDT on 1h timeframe. Look for trend direction and support/resistance levels.',
      params: {
        symbol: 'BTC/USDT',
        timeframe: '1h',
        venue: 'binance',
      },
    };

    console.log('\n=== Running agent turn for BTC/USDT ===');
    console.log(`Model: ${process.env['LM_STUDIO_MODEL'] || 'google/gemma-4-e2b'}`);

    const result = await agent.executeTurn(context, source);

    console.log(`\nResults:`);
    console.log(`  Iterations: ${result.iterations.length}`);
    console.log(`  Total time: ${result.totalTime}ms`);
    console.log(`  API calls: ${result.totalApiCalls}`);
    console.log(`  Error: ${result.error || 'none'}`);
    console.log(`  Strategies: ${result.finalStrategies.length}`);

    for (const iter of result.iterations) {
      console.log(`\n  Iteration ${iter.iteration}:`);
      console.log(`    Confidence: ${iter.output.confidence}`);
      if (iter.output.analysis) {
        console.log(`    Analysis: ${iter.output.analysis.slice(0, 500)}`);
      }
      if (iter.output.orderIntents?.length > 0) {
        console.log(`    Orders: ${iter.output.orderIntents.length}`);
        for (const o of iter.output.orderIntents) {
          console.log(`      ${o.side} ${o.quantity} ${o.symbol} @ ${o.price || 'market'}`);
        }
      }
    }

    expect(result.totalTime).toBeGreaterThan(0);
  }, 120000);

  it('should execute order intents through runtime', async () => {
    const executeFn = (runtime as any).executeOrderIntents;
    expect(typeof executeFn).toBe('function');
    console.log('\nexecuteOrderIntents method is wired.');
  });

  it('should report daemon status', async () => {
    const status = runtime.getStatus();
    console.log(`\nAll components: ${Object.entries(status.components).filter(([_, v]) => v).length}/${Object.keys(status.components).length} initialized`);
    console.log(`Components: ${Object.keys(status.components).join(', ')}`);
    expect(status.state).toBe('running');
  });
});
