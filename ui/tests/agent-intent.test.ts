import { describe, it, expect } from 'vitest';
import { normalizeIntentRoute, type IntentRoute } from '../src/core/intent-router.js';

describe('normalizeIntentRoute', () => {
  it('normalizes a fully-specified valid route', () => {
    const route = normalizeIntentRoute({
      intent: 'coding',
      useTools: true,
      shouldPlan: true,
      rationale: 'User wants to build something',
      preferredTools: ['write', 'read'],
    });

    expect(route).toEqual({
      intent: 'coding',
      useTools: true,
      shouldPlan: true,
      rationale: 'User wants to build something',
      preferredTools: ['write', 'read'],
    });
  });

  it('accepts every valid intent value', () => {
    for (const intent of ['coding', 'market_data', 'portfolio', 'general'] as const) {
      expect(normalizeIntentRoute({ intent })?.intent).toBe(intent);
    }
  });

  it('returns null for an invalid intent', () => {
    expect(normalizeIntentRoute({ intent: 'invalid_intent' })).toBeNull();
  });

  it('returns null when intent is missing', () => {
    expect(normalizeIntentRoute({})).toBeNull();
  });

  it('defaults useTools to true for tool-able intents and false for general', () => {
    expect(normalizeIntentRoute({ intent: 'coding' })?.useTools).toBe(true);
    expect(normalizeIntentRoute({ intent: 'market_data' })?.useTools).toBe(true);
    expect(normalizeIntentRoute({ intent: 'portfolio' })?.useTools).toBe(true);
    expect(normalizeIntentRoute({ intent: 'general' })?.useTools).toBe(false);
  });

  it('defaults shouldPlan to false', () => {
    expect(normalizeIntentRoute({ intent: 'coding' })?.shouldPlan).toBe(false);
  });

  it('uses the provided boolean fields when present', () => {
    const route = normalizeIntentRoute({ intent: 'coding', useTools: false, shouldPlan: true });
    expect(route?.useTools).toBe(false);
    expect(route?.shouldPlan).toBe(true);
  });

  it('rejects non-boolean useTools and shouldPlan values', () => {
    const route = normalizeIntentRoute({
      intent: 'coding',
      useTools: 'yes',
      shouldPlan: 1,
    } as unknown as Record<string, unknown>);
    expect(route?.useTools).toBe(true);
    expect(route?.shouldPlan).toBe(false);
  });

  it('falls back to a default rationale when none is provided', () => {
    expect(normalizeIntentRoute({ intent: 'coding' })?.rationale).toBe(
      'Route selected by the model.'
    );
  });

  it('trims rationale and filters empty or non-string preferred tools', () => {
    const route = normalizeIntentRoute({
      intent: 'coding',
      rationale: '  trimmed  ',
      preferredTools: [' write ', '', 'grep', '   ', 42],
    });
    expect(route?.rationale).toBe('trimmed');
    expect(route?.preferredTools).toEqual([' write ', 'grep']);
  });

  it('always produces a valid IntentRoute', () => {
    const route: IntentRoute | null = normalizeIntentRoute({ intent: 'market_data' });
    expect(route).not.toBeNull();
    expect(route!.intent).toBe('market_data');
  });
});