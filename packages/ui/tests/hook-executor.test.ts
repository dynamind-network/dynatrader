import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('hook executor source', () => {
  it('fails closed when no hook model is configured', () => {
    const file = join(__dirname, '../../core/src/agent/core/event-hooks/hook-executor.ts');
    const content = readFileSync(file, 'utf-8');

    expect(content).toContain('No default model available for prompt hooks.');
    expect(content).toContain('No default model available for agent hooks.');
    expect(content).toContain('this.defaultModel');
    expect(content).not.toContain('resolveDefaultModel({})');
  });
});
