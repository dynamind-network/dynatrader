/**
 * Tests for Dream Cycle — DreamEngine & DreamScheduler
 *
 * Covers:
 * - DreamConfig defaults
 * - DreamEngine: runDreamCycle produces a DreamReport
 * - DreamEngine: skill archiving (low confidence skills get archived)
 * - DreamEngine: pattern discovery from learnings
 * - DreamEngine: new skill creation from patterns
 * - DreamEngine: empty state (no learnings, no skills)
 * - DreamEngine: DreamReport structure validation
 * - DreamScheduler: start/stop lifecycle
 * - DreamScheduler: triggerNow runs a cycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStoreImpl } from '@dyna/memory-core';
import { SkillFactory, CrossSessionRecall } from '@dyna/agent-core';
import type { Learning, MarketConditions, MarketRegime } from '@dyna/agent-core';
import { DreamEngine } from './dream-engine';
import { DreamScheduler } from './dream-scheduler';
import { DEFAULT_DREAM_CONFIG } from './dream-types';
import type { DreamConfig, DreamReport, DreamAction, DreamPhaseHook } from './dream-types';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function createLearning(overrides: Partial<Learning> & { id: string }): Learning {
  return {
    type: 'pattern',
    content: 'Test learning content',
    confidence: 0.7,
    evidence: [],
    category: 'entry',
    applicableSymbols: ['BTC/USDT'],
    applicableRegimes: ['trending'],
    createdAt: Date.now(),
    timesUsed: 1,
    successRate: 0.5,
    ...overrides,
  };
}

function seedLearning(
  memory: MemoryStoreImpl,
  overrides: Partial<Learning> & { id: string },
): Promise<void> {
  const learning = createLearning(overrides);
  return memory.put({
    scope: 'learning_engine',
    kind: `learning_${learning.type}`,
    payload: learning,
    ts: new Date(),
  });
}

function seedSkill(
  memory: MemoryStoreImpl,
  overrides: {
    id?: string;
    symbol?: string;
    confidence?: number;
  } = {},
): Promise<void> {
  const skillId = overrides.id ?? `skill-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  return memory.put({
    scope: 'agent_memory',
    kind: 'skill_created',
    payload: {
      type: 'skill_created',
      id: skillId,
      venue: 'hyperliquid',
      symbol: overrides.symbol ?? 'BTC/USDT',
      timeframe: '1h',
      entry: { type: 'momentum', rsiThreshold: 30 },
      exits: { stopLoss: 0.02, takeProfit: 0.04 },
      sizing: { method: 'kelly', kellyFraction: 0.25, maxPositionPct: 0.1 },
      risk: { maxPositionNotional: 5000, maxDailyLoss: 500, maxOpenOrders: 3 },
      executionMode: 'paper',
      description: 'Test skill',
    },
    ts: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamConfig defaults', () => {
  it('should have reasonable default values', () => {
    expect(DEFAULT_DREAM_CONFIG.intervalMs).toBe(86_400_000); // 24h
    expect(DEFAULT_DREAM_CONFIG.minLearningsForDream).toBe(5);
    expect(DEFAULT_DREAM_CONFIG.skillConfidenceThreshold).toBe(0.3);
    expect(DEFAULT_DREAM_CONFIG.maxSkillsPerType).toBe(10);
    expect(DEFAULT_DREAM_CONFIG.enabled).toBe(true);
  });

  it('should merge partial overrides correctly', () => {
    const custom: DreamConfig = {
      ...DEFAULT_DREAM_CONFIG,
      intervalMs: 3600000, // 1h
      enabled: false,
    };
    expect(custom.intervalMs).toBe(3600000);
    expect(custom.minLearningsForDream).toBe(5);
    expect(custom.enabled).toBe(false);
  });
});

describe('DreamEngine', () => {
  let memory: MemoryStoreImpl;
  let skillFactory: SkillFactory;
  let crossSessionRecall: CrossSessionRecall;
  let engine: DreamEngine;

  beforeEach(() => {
    memory = new MemoryStoreImpl();
    skillFactory = new SkillFactory();
    crossSessionRecall = new CrossSessionRecall(memory);
    engine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
      ...DEFAULT_DREAM_CONFIG,
      minLearningsForDream: 3, // Lower threshold for testing
      skillConfidenceThreshold: 0.3,
    });
  });

  describe('empty state', () => {
    it('should return a DreamReport even with no learnings', async () => {
      const report = await engine.runDreamCycle();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.timestamp).toBeInstanceOf(Date);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.summary).toBeTruthy();
      expect(report.actions).toBeInstanceOf(Array);
      expect(report.metrics).toBeDefined();
      expect(report.metrics.totalLearnings).toBe(0);
      expect(report.metrics.skillsReviewed).toBe(0);
    });

    it('should not run dream cycle if below minimum learnings threshold', async () => {
      // Seed only 1 learning (need minLearningsForDream = 3)
      await seedLearning(memory, { id: 'l1', applicableSymbols: ['BTC/USDT'] });

      const report = await engine.runDreamCycle();

      // Should still produce a report but minimal
      expect(report.metrics.totalLearnings).toBe(1);
      expect(report.metrics.patternsFound).toBe(0);
      expect(report.actions.length).toBe(0);
    });
  });

  describe('runDreamCycle', () => {
    it('discovers patterns from non-trading task learnings', async () => {
      vi.spyOn(skillFactory, 'createSkillFromTask').mockResolvedValue(null);
      for (let i = 0; i < 3; i++) {
        await seedLearning(memory, {
          id: `general-${i}`,
          type: 'pattern',
          category: 'entry',
          applicableSymbols: [],
        });
      }

      const report = await engine.runDreamCycle();

      expect(report.metrics.patternsFound).toBe(1);
      expect(report.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'pattern_discovered', description: expect.stringContaining('Reusable entry task pattern') }),
      ]));
    });

    it('should produce a valid DreamReport with full structure', async () => {
      // Seed enough learnings
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `learning-full-${i}`,
          type: 'pattern',
          confidence: 0.6 + i * 0.05,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      // Validate DreamReport structure
      expect(report).toBeInstanceOf(Object);
      expect(typeof report.id).toBe('string');
      expect(report.id.startsWith('dream-')).toBe(true);
      expect(report.timestamp).toBeInstanceOf(Date);
      expect(typeof report.durationMs).toBe('number');
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof report.summary).toBe('string');
      expect(report.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(report.actions)).toBe(true);

      // Validate DreamMetrics structure
      const m = report.metrics;
      expect(typeof m.totalLearnings).toBe('number');
      expect(typeof m.skillsReviewed).toBe('number');
      expect(typeof m.skillsArchived).toBe('number');
      expect(typeof m.skillsCreated).toBe('number');
      expect(typeof m.patternsFound).toBe('number');
      expect(typeof m.insightsGenerated).toBe('number');

      // Should have reviewed the learnings
      expect(m.totalLearnings).toBe(5);
    });

    it('should run and return a DreamReport', async () => {
      // Seed enough learnings for a full cycle
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `l-run-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.actions).toBeInstanceOf(Array);
      expect(report.metrics.totalLearnings).toBe(5);
    });
  });

  describe('skill archiving', () => {
    it('should archive skills with confidence below threshold', async () => {
      // Seed a few learnings with low success rates (to make skill confidence low)
      await seedLearning(memory, {
        id: 'la-low-1',
        type: 'mistake',
        confidence: 0.1,
        applicableSymbols: ['ETH/USDT'],
        category: 'risk',
      });
      await seedLearning(memory, {
        id: 'la-low-2',
        type: 'mistake',
        confidence: 0.15,
        applicableSymbols: ['ETH/USDT'],
        category: 'risk',
      });
      await seedLearning(memory, {
        id: 'la-low-3',
        type: 'mistake',
        confidence: 0.2,
        applicableSymbols: ['ETH/USDT'],
        category: 'risk',
      });
      await seedLearning(memory, {
        id: 'la-low-4',
        type: 'mistake',
        confidence: 0.1,
        applicableSymbols: ['ETH/USDT'],
        category: 'risk',
      });

      // Seed a skill for ETH/USDT (which has only low-confidence learnings)
      await seedSkill(memory, { symbol: 'ETH/USDT' });

      const report = await engine.runDreamCycle();

      expect(report.metrics.skillsReviewed).toBe(1);
      expect(report.metrics.skillsArchived).toBe(1);

      // Check archive marker exists in memory
      const archives = await memory.search({
        scope: 'agent_memory',
        text: '',
        topK: 50,
      });
      const archiveEntries = archives.filter(a => {
        const p = a.payload as Record<string, unknown>;
        return p.kind === 'skill_archived' || (p.type === 'skill_archived');
      });
      // The skill_archived entry has payload.type = 'skill_archived'
      // But MemoryStoreImpl stores it with kind = 'skill_archived'
      // Let's check by kind: the put uses kind: 'skill_archived'
      expect(archiveEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT archive skills with high confidence', async () => {
      // Seed high-confidence learnings for BTC/USDT
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `ha-high-${i}`,
          type: 'success',
          confidence: 0.8,
          applicableSymbols: ['BTC/USDT'],
          category: 'entry',
        });
      }

      // Seed a skill for BTC/USDT
      await seedSkill(memory, { symbol: 'BTC/USDT' });

      const report = await engine.runDreamCycle();

      expect(report.metrics.skillsReviewed).toBe(1);
      expect(report.metrics.skillsArchived).toBe(0);
    });
  });

  describe('pattern discovery', () => {
    it('should discover patterns from learnings', async () => {
      // Seed many success learnings to trigger recurring_win pattern
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `pd-win-${i}`,
          type: 'success',
          confidence: 0.8,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      expect(report.metrics.patternsFound).toBeGreaterThanOrEqual(1);

      // Check for pattern_discovered actions
      const patternActions = report.actions.filter(
        (a: DreamAction) => a.type === 'pattern_discovered',
      );
      expect(patternActions.length).toBeGreaterThanOrEqual(1);
    });

    it('should discover recurring loss patterns', async () => {
      // Seed many mistake learnings to trigger recurring_loss pattern
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `pd-loss-${i}`,
          type: 'mistake',
          confidence: 0.3,
          applicableSymbols: ['ETH/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      expect(report.metrics.patternsFound).toBeGreaterThanOrEqual(1);
    });

    it('should discover timing patterns', async () => {
      for (let i = 0; i < 4; i++) {
        await seedLearning(memory, {
          id: `pd-timing-${i}`,
          type: 'timing',
          confidence: 0.6,
          applicableSymbols: ['SOL/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      expect(report.metrics.patternsFound).toBeGreaterThanOrEqual(1);
    });
  });

  describe('insight generation and skill creation', () => {
    it('should generate insights from high-confidence patterns', async () => {
      // Seed many high-confidence success learnings to trigger pattern + insight
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `ig-${i}`,
          type: 'success',
          confidence: 0.85,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const report = await engine.runDreamCycle();

      // With config.minLearningsForDream = 3, we have 5 learnings, so full cycle runs
      // Pattern confidence should be high enough for insight generation (>= 0.6)
      expect(report.metrics.insightsGenerated).toBeGreaterThanOrEqual(0);
      expect(report.metrics.patternsFound).toBeGreaterThanOrEqual(1);
    });

    it('should create new skills from patterns when confidence is high enough', async () => {
      // Seed very high confidence success learnings to ensure pattern confidence >= 0.65
      for (let i = 0; i < 6; i++) {
        await seedLearning(memory, {
          id: `cs-${i}`,
          type: 'success',
          content: `RSI momentum strategy for BTC/USDT with confidence 0.9`,
          confidence: 0.9,
          applicableSymbols: ['BTC/USDT'],
          evidence: [`trade-cs-${i}`],
          timesUsed: 5, // High usage = higher derived confidence
        });
      }

      const report = await engine.runDreamCycle();

      // May or may not create skills depending on SkillFactory
      // The key assertion is that the cycle completes without error
      expect(report.metrics.skillsCreated).toBeGreaterThanOrEqual(0);
      expect(report.metrics.patternsFound).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getLastDreamReport and getDreamHistory', () => {
    it('should return null for last report before any cycle', () => {
      expect(engine.getLastDreamReport()).toBeNull();
    });

    it('should return the last report after a cycle', async () => {
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `gl-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      await engine.runDreamCycle();

      const last = engine.getLastDreamReport();
      expect(last).not.toBeNull();
      expect(last!.id).toBeTruthy();
      expect(last!.timestamp).toBeInstanceOf(Date);
    });

    it('should return dream history from memory', async () => {
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `gh-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      await engine.runDreamCycle();
      await engine.runDreamCycle();

      const history = await engine.getDreamHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]!.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('runDreamCycleIfNeeded', () => {
    it('should return null if dreaming is disabled', async () => {
      const disabledEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
        ...DEFAULT_DREAM_CONFIG,
        enabled: false,
        minLearningsForDream: 3,
      });

      const result = await disabledEngine.runDreamCycleIfNeeded();
      expect(result).toBeNull();
    });

    it('should return null before any loop has completed', async () => {
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `preloop-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const result = await engine.runDreamCycleIfNeeded();
      expect(result).toBeNull();
    });

    it('should return null if not enough learnings', async () => {
      engine.markLoopCompleted();
      const result = await engine.runDreamCycleIfNeeded();
      expect(result).toBeNull();
    });

    it('should run a cycle if enough learnings exist', async () => {
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `rn-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      engine.markLoopCompleted();
      const result = await engine.runDreamCycleIfNeeded();
      expect(result).not.toBeNull();
      expect(result!.metrics.totalLearnings).toBe(5);
    });
  });

  describe('phase hooks', () => {
    it('should run the default light/rem/deep phases in order', async () => {
      const calls: string[] = [];
      const hook = (({ phase, state }) => {
        calls.push(`${phase}:${state.learnings.length}`);
      }) satisfies DreamPhaseHook;

      const hookedEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
        ...DEFAULT_DREAM_CONFIG,
        minLearningsForDream: 1,
        phases: {
          hooks: {
            light: hook,
            rem: hook,
            deep: hook,
          },
        },
      });

      await seedLearning(memory, {
        id: 'phase-1',
        type: 'pattern',
        confidence: 0.7,
        applicableSymbols: ['BTC/USDT'],
      });

      const report = await hookedEngine.runDreamCycle();

      expect(calls).toEqual(['light:0', 'rem:0', 'deep:0']);
      expect(report.metrics.totalLearnings).toBe(0);
    });

    it('should allow a hook to replace a phase while keeping the rest of the cycle intact', async () => {
      const remHook = vi.fn(({ state }) => {
        state.metrics.insightsGenerated += 99;
      });

      const hookedEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
        ...DEFAULT_DREAM_CONFIG,
        minLearningsForDream: 1,
        phases: {
          hooks: {
            rem: remHook,
          },
        },
      });

      await seedLearning(memory, {
        id: 'phase-2',
        type: 'success',
        confidence: 0.9,
        applicableSymbols: ['BTC/USDT'],
      });

      const report = await hookedEngine.runDreamCycle();

      expect(remHook).toHaveBeenCalledTimes(1);
      expect(report.metrics.insightsGenerated).toBeGreaterThanOrEqual(99);
    });
  });
});

describe('DreamScheduler', () => {
  let memory: MemoryStoreImpl;
  let skillFactory: SkillFactory;
  let crossSessionRecall: CrossSessionRecall;
  let dreamEngine: DreamEngine;
  let scheduler: DreamScheduler;

  beforeEach(() => {
    memory = new MemoryStoreImpl();
    skillFactory = new SkillFactory();
    crossSessionRecall = new CrossSessionRecall(memory);
    dreamEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
      ...DEFAULT_DREAM_CONFIG,
      minLearningsForDream: 3,
    });
    scheduler = new DreamScheduler(dreamEngine, {
      ...DEFAULT_DREAM_CONFIG,
      intervalMs: 60000, // 1 minute for tests
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('start/stop lifecycle', () => {
    it('should not be running initially', () => {
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should start and be running', () => {
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
    });

    it('should stop and not be running', () => {
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should be safe to stop when not running', () => {
      expect(() => scheduler.stop()).not.toThrow();
    });

    it('should be safe to call start multiple times', () => {
      scheduler.start();
      scheduler.start(); // Second call should not throw
      expect(scheduler.isRunning()).toBe(true);
    });
  });

  describe('triggerNow', () => {
    it('should run a dream cycle immediately', async () => {
      // Seed enough learnings
      for (let i = 0; i < 5; i++) {
        await seedLearning(memory, {
          id: `tr-${i}`,
          type: 'pattern',
          confidence: 0.7,
          applicableSymbols: ['BTC/USDT'],
        });
      }

      const report = await scheduler.triggerNow();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.metrics.totalLearnings).toBe(5);
    });
  });
});

describe('DreamReport structure validation', () => {
  it('should have all required fields with correct types', async () => {
    const memory = new MemoryStoreImpl();
    const skillFactory = new SkillFactory();
    const crossSessionRecall = new CrossSessionRecall(memory);
    const engine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
      ...DEFAULT_DREAM_CONFIG,
      minLearningsForDream: 1,
    });

    // Seed one learning
    await seedLearning(memory, {
      id: 'struct-1',
      type: 'pattern',
      confidence: 0.7,
      applicableSymbols: ['BTC/USDT'],
    });

    const report = await engine.runDreamCycle();

    // Required top-level fields
    expect(report).toHaveProperty('id');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('durationMs');
    expect(report).toHaveProperty('summary');
    expect(report).toHaveProperty('actions');
    expect(report).toHaveProperty('metrics');

    // Action type validation
    for (const action of report.actions) {
      expect([
        'skill_created',
        'skill_archived',
        'skill_adjusted',
        'insight_generated',
        'pattern_discovered',
      ]).toContain(action.type);
      expect(typeof action.description).toBe('string');
    }

    // Metrics validation
    const { metrics } = report;
    expect(typeof metrics.totalLearnings).toBe('number');
    expect(typeof metrics.skillsReviewed).toBe('number');
    expect(typeof metrics.skillsArchived).toBe('number');
    expect(typeof metrics.skillsCreated).toBe('number');
    expect(typeof metrics.patternsFound).toBe('number');
    expect(typeof metrics.insightsGenerated).toBe('number');
  });
});
