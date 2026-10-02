import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invalidateProvidersCache, loadProvidersFromYAML } from './yaml-loader.js';

const temporaryDirectories: string[] = [];

async function loadWorkspaceModels(contents: string) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dyna-model-providers-'));
  temporaryDirectories.push(workspace);
  const configDirectory = path.join(workspace, '.dynatrader');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, 'models.yaml'), contents);
  return loadProvidersFromYAML({ workspaceDir: workspace, force: true });
}

afterEach(async () => {
  invalidateProvidersCache();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('model provider URL policy', () => {
  it('allows HTTP endpoints on loopback for local model providers', async () => {
    const providers = await loadWorkspaceModels(`providers:\n  ollama:\n    baseUrl: http://localhost:11434/v1\n    models:\n      - id: local-model\n        name: Local model\n        contextWindow: 8192\n        maxOutput: 2048\n  lmstudio:\n    baseUrl: http://127.0.0.1:1234/v1\n    models:\n      - id: studio-model\n        name: Studio model\n        contextWindow: 8192\n        maxOutput: 2048\n`);

    expect(providers.ollama?.baseUrl).toBe('http://localhost:11434/v1');
    expect(providers.lmstudio?.baseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('continues to reject non-loopback HTTP provider endpoints', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const providers = await loadWorkspaceModels(`providers:\n  remote-insecure:\n    baseUrl: http://example.com/v1\n    models:\n      - id: remote-model\n        name: Remote model\n        contextWindow: 8192\n        maxOutput: 2048\n  private-network:\n    baseUrl: http://192.168.1.10/v1\n    models:\n      - id: private-model\n        name: Private model\n        contextWindow: 8192\n        maxOutput: 2048\n`);

    expect(providers['remote-insecure']?.baseUrl).toBeUndefined();
    expect(providers['private-network']?.baseUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
