import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useAgent hook', () => {
  const hookPath = join(__dirname, '../src/ui/hooks/use-agent.ts');
  const content = readFileSync(hookPath, 'utf-8');

  it('clears stale tool and approval state on runtime errors', () => {
    expect(content).toContain('setToolExecutions([]);');
    expect(content).toContain('setApprovalPending(null);');
  });

  it('marks failed tool completions as errors instead of success', () => {
    expect(content).toContain("status: isError ? 'error' : 'complete'");
    expect(content).toContain('success === false');
  });
});
