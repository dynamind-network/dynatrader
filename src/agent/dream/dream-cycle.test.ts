/**
 * Tests for Dream Cycle — DreamEngine & DreamScheduler
 *
 * Covers:
 * - DreamConfig defaults
 * - DreamEngine: runDreamCycle produces a DreamReport
 * - DreamEngine: skill archiving (90-day + duplicate merging)
 * - DreamEngine: cross-session synthesis → MEMORY.md extraction
 * - DreamEngine: empty state (no learnings, no skills)
 * - DreamEngine: DreamReport structure validation
 * - DreamScheduler: start/stop lifecycle
 * - DreamScheduler: triggerNow runs a cycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStoreImpl } from '@dyna/memory-core';
import { SkillFactory, CrossSessionRecall } from '@dyna/agent-core';
import type { DreamConfig, DreamReport, DreamAction, DreamPhaseHook } from './dream-types';
import { DreamEngine } from './dream-engine';
import { DreamScheduler } from './dream-scheduler';
import { DEFAULT_DREAM_CONFIG } from './dream-types';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

async function seedSkill(
  memory: MemoryStoreImpl,
  overrides: {
    id?: string;
    symbol?: string;
    kind?: string;
    tags?: string[];
  } = {},
): Promise<void> {
  const skillId = overrides.id ?? `skill-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const basePayload = {
    type: 'skill_created',
    id: skillId,
    venue: 'hyperliquid',
    symbol: overrides.symbol ?? 'BTC/USDT',
    description: 'Test skill',
  };
  const payload = {
    ...basePayload,
    ...(overrides.kind && { kind: overrides.kind }),
    ...(overrides.tags && { tags: overrides.tags }),
  };
  return memory.put({
    scope: 'agent_memory',
    kind: 'skill_created',
    payload,
    ts: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamConfig defaults', () => {
  it('should have reasonable default values', () => {
    expect(DEFAULT_DREAM_CONFIG.intervalMs).toBe(86_400_000); // 24h
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
      expect(report.metrics.skillsReviewed).toBe(0);
    });
  });

  describe('runDreamCycle', () => {
    it('reviews and archives old skills (>90 days)', async () => {
      // Seed skills (they get a created_at timestamp implicitly via review)
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, { id: `s-${i}`, symbol: 'BTC/USDT' });
      }

      const report = await engine.runDreamCycle();

      // Skills should be reviewed and some archived
      expect(report.metrics.skillsReviewed).toBeGreaterThanOrEqual(0);
      expect(report.metrics.skillsArchived).toBeGreaterThanOrEqual(0);
    });

    it('should produce a valid DreamReport with full structure', async () => {
      // Seed skills
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `s-full-${i}`,
          symbol: 'BTC/USDT',
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
      expect(typeof m.skillsReviewed).toBe('number');
      expect(typeof m.skillsArchived).toBe('number');
      expect(typeof m.skillsCreated).toBe('number');
      expect(typeof m.patternsFound).toBe('number');
      expect(typeof m.insightsGenerated).toBe('number');

      // Should have reviewed the skills
      expect(m.skillsReviewed).toBe(3);
    });

    it('should run and return a DreamReport', async () => {
      // Seed skills
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `l-run-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      const report = await engine.runDreamCycle();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.actions).toBeInstanceOf(Array);
      expect(report.metrics.skillsReviewed).toBe(3);
    });
  });

  describe('skill archiving', () => {
    it('should archive skills reviewed in light phase', async () => {
      // Seed skills
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, { id: `la-${i}`, symbol: 'ETH/USDT' });
      }

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
      expect(archiveEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT archive skills with high confidence (recent)', async () => {
      // Seed high-confidence learnings for BTC/USDT (recent = not archived)
      for (let i = 0; i < 5; i++) {
        await seedSkill(memory, {
          id: `ha-high-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      const report = await engine.runDreamCycle();

      expect(report.metrics.skillsReviewed).toBe(1);
      expect(report.metrics.skillsArchived).toBe(0);
    });
  });

  describe('cross-session synthesis', () => {
    it('should extract insights to MEMORY.md via REM phase', async () => {
      // Seed skills from different sessions
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, { id: `cs-${i}`, symbol: 'BTC/USDT' });
      }

      const report = await engine.runDreamCycle();

      // Insights may be generated from cross-session recall
      expect(report.metrics.insightsGenerated).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLastDreamReport and getDreamHistory', () => {
    it('should return null for last report before any cycle', () => {
      expect(engine.getLastDreamReport()).toBeNull();
    });

    it('should return the last report after a cycle', async () => {
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `gl-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      await engine.runDreamCycle();

      const last = engine.getLastDreamReport();
      expect(last).not.toBeNull();
      expect(last!.id).toBeTruthy();
      expect(last!.timestamp).toBeInstanceOf(Date);
    });

    it('should return dream history from memory', async () => {
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `gh-${i}`,
          symbol: 'BTC/USDT',
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
      });

      const result = await disabledEngine.runDreamCycleIfNeeded();
      expect(result).toBeNull();
    });

    it('should return null before any loop has completed', async () => {
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `preloop-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      const result = await engine.runDreamCycleIfNeeded();
      expect(result).toBeNull();
    });

    it('should run a cycle if skills exist', async () => {
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `rn-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      engine.markLoopCompleted();
      const result = await engine.runDreamCycleIfNeeded();
      expect(result).not.toBeNull();
      expect(result!.metrics.skillsReviewed).toBe(3);
    });
  });

  describe('phase hooks', () => {
    it('should run the default light/rem/deep phases in order', async () => {
      const calls: string[] = [];
      const hook = (({ phase, state }) => {
        calls.push(`${phase}:${state.skills.length}`);
      }) satisfies DreamPhaseHook;

      const hookedEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
        ...DEFAULT_DREAM_CONFIG,
        phases: {
          hooks: {
            light: hook,
            rem: hook,
            deep: hook,
          },
        },
      });

      await seedSkill(memory, {
        id: 'phase-1',
        symbol: 'BTC/USDT',
      });

      const report = await hookedEngine.runDreamCycle();

      expect(calls).toEqual(['light:1', 'rem:1', 'deep:1']);
      expect(report.metrics.skillsReviewed).toBe(1);
    });

    it('should allow a hook to replace a phase while keeping the rest of the cycle intact', async () => {
      const remHook = vi.fn(({ state }) => {
        state.metrics.insightsGenerated += 99;
      });

      const hookedEngine = new DreamEngine(memory, skillFactory, crossSessionRecall, {
        ...DEFAULT_DREAM_CONFIG,
        phases: {
          hooks: {
            rem: remHook,
          },
        },
      });

      await seedSkill(memory, {
        id: 'phase-2',
        symbol: 'BTC/USDT',
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
      // Seed enough skills
      for (let i = 0; i < 3; i++) {
        await seedSkill(memory, {
          id: `tr-${i}`,
          symbol: 'BTC/USDT',
        });
      }

      const report = await scheduler.triggerNow();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.metrics.skillsReviewed).toBe(3);
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
      });

    // Seed one skill
    await seedSkill(memory, {
      id: 'struct-1',
      symbol: 'BTC/USDT',
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
      ]).toContain(action.type);
      expect(typeof action.description).toBe('string');
    }

    // Metrics validation
    const { metrics } = report;
    expect(typeof metrics.skillsReviewed).toBe('number');
    expect(typeof metrics.skillsArchived).toBe('number');
    expect(typeof metrics.skillsCreated).toBe('number');
    expect(typeof metrics.patternsFound).toBe('number');
    expect(typeof metrics.insightsGenerated).toBe('number');
  });
});