import { describe, expect, it } from 'vitest';
import { parseCliSessionOptions, selectInitialSessionId } from './cli-session-options.js';

describe('parseCliSessionOptions', () => {
  it('accepts --resume as an alias for --session', () => {
    expect(parseCliSessionOptions(['--resume', 'session-123'])).toEqual({
      sessionId: 'session-123',
      sessionRequested: false,
      resumeRequested: true,
      continueSession: false,
    });
  });

  it('accepts equals syntax and the short session flag', () => {
    expect(parseCliSessionOptions(['--resume=session-123'])).toMatchObject({ sessionId: 'session-123' });
    expect(parseCliSessionOptions(['-s', 'session-456'])).toMatchObject({ sessionId: 'session-456' });
  });

  it('selects the latest saved session when --continue is requested', () => {
    expect(parseCliSessionOptions(['--continue'])).toMatchObject({
      resumeRequested: false,
      continueSession: true,
    });
    expect(parseCliSessionOptions([], { DYNATRADER_CONTINUE: 'true' })).toMatchObject({
      continueSession: true,
    });
  });

  it('reads a session ID passed by the dispatcher environment', () => {
    expect(parseCliSessionOptions([], { DYNATRADER_SESSION: 'session-env' })).toMatchObject({
      sessionId: 'session-env',
    });
  });

  it('marks an ID-less session flag so the CLI can report usage instead of starting a new chat', () => {
    expect(parseCliSessionOptions(['--session'])).toMatchObject({
      sessionRequested: true,
      sessionId: undefined,
    });
  });

  it('continues the most recently updated session while honoring an explicit session', () => {
    const recent = [{ id: 'latest' }, { id: 'older' }];
    expect(selectInitialSessionId(undefined, true, recent)).toBe('latest');
    expect(selectInitialSessionId('chosen', true, recent)).toBe('chosen');
    expect(selectInitialSessionId(undefined, false, recent)).toBeUndefined();
    expect(selectInitialSessionId(undefined, true, [])).toBeUndefined();
  });
});
