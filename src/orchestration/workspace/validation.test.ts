import { describe, expect, it } from 'vitest';
import { WorkspaceValidator } from './validation';

describe('WorkspaceValidator', () => {
  it('does not require USER or HEARTBEAT files in the base manifest', () => {
    const validator = new WorkspaceValidator();

    const result = validator.validateManifest({
      soul: '# soul',
      identity: '# identity',
      memory: '# memory',
      auth: {},
      config: {},
      agents: [],
      skills: [],
      tools: [],
      adapters: [],
      policies: [],
    } as never);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
