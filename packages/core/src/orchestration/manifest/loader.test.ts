import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestLoader } from './loader';

const validFrontmatter = `name: analyst
version: "1.0.0"
description: Test agent
filename: forged.agent.md
allowedModes: [research]
permissions: { allow: [], deny: [] }
tools: { allow: [], deny: [] }
skills: { allow: [], deny: [] }
memory: { read: [], write: [] }
outputs: []
approvalRequiredFor: []
riskLevel: low`;

describe('ManifestLoader agent YAML boundaries', () => {
  let tempDirectory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('uses the source filename and returns the validated manifest with instructions', async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'dyna-manifest-'));
    writeFileSync(join(tempDirectory, 'actual.agent.md'), `---\n${validFrontmatter}\n---\nAgent instructions`);

    const [manifest] = await new ManifestLoader().loadFromDirectory(tempDirectory, 'agent');

    expect(manifest.validated).toBe(true);
    expect(manifest.data).toMatchObject({
      name: 'analyst',
      filename: 'actual.agent.md',
      instructions: 'Agent instructions',
    });
  });

  it('rejects scalar YAML frontmatter without throwing out of the directory scan', async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'dyna-manifest-scalar-'));
    writeFileSync(join(tempDirectory, 'scalar.agent.md'), '---\nscalar value\n---\nNo mapping');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(new ManifestLoader().loadFromDirectory(tempDirectory, 'agent')).resolves.toEqual([]);
  });
});
