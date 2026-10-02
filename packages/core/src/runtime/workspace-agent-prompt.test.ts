import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorkspaceAgentPrompt } from './workspace-agent-prompt';

describe('loadWorkspaceAgentPrompt', () => {
  it('composes workspace instructions from workspace files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dyna-workspace-prompt-'));
    try {
      await writeFile(path.join(dir, 'SOUL.md'), '# SOUL\nFollow the steps.\n', 'utf-8');
      await writeFile(path.join(dir, 'AGENTS.md'), '# AGENTS\n1. Inspect.\n2. Decide.\n', 'utf-8');
      await writeFile(
        path.join(dir, 'IDENTITY.md'),
        `---\nname: test-agent\nrole: Primary workspace agent\n---\n\n# IDENTITY\n`,
        'utf-8',
      );
      await writeFile(path.join(dir, 'USER.md'), '# USER\nRisk tolerance: moderate.\n', 'utf-8');

      const prompt = await loadWorkspaceAgentPrompt(dir);

      expect(prompt).toContain('Workspace instructions define the agent identity');
      expect(prompt).toContain(`Agent workspace root: ${dir}`);
      expect(prompt).toContain('Follow the steps.');
      expect(prompt).toContain('1. Inspect.');
      expect(prompt).toContain('test-agent');
      expect(prompt).toContain('Risk tolerance: moderate.');
      expect(prompt).not.toContain('HEARTBEAT');
      expect(prompt).not.toContain('LEARNINGS');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
