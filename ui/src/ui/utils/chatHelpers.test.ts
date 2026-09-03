import { describe, it, expect } from 'vitest';
import { summarizeToolOutput } from './chatHelpers.js';

describe('summarizeToolOutput', () => {
  it('keeps the start and end of long output', () => {
    const output = `begin ${'a '.repeat(100)}finish`;
    const summary = summarizeToolOutput(output);
    expect(summary).toContain('begin');
    expect(summary).toContain('finish');
    expect(summary.length).toBeLessThan(output.length);
  });

  it('returns completed for blank output', () => {
    expect(summarizeToolOutput('   \n  ')).toBe('completed');
  });
});
