import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('HelpScreen', () => {
  const helpScreenPath = join(__dirname, '../src/ui/screens/HelpScreen.tsx');
  const content = readFileSync(helpScreenPath, 'utf-8');

  it('describes agents as workspace-managed', () => {
    expect(content).toContain('workspace agents');
    expect(content).toContain('markdown files');
    expect(content).toContain('@name');
  });

  it('does not advertise bundled default subagents', () => {
    expect(content).not.toContain('@general');
    expect(content).not.toContain('@task');
    expect(content).not.toContain('built-in and custom subagents');
  });
});
