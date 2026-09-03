import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDynatraderLaunchSpec } from '../src/core/dynatrader-launcher.js';

describe('resolveDynatraderLaunchSpec', () => {
  it('prefers DYNATRADER_ENTRY when provided', () => {
    const spec = resolveDynatraderLaunchSpec({
      cwd: '/workspace',
      env: { DYNATRADER_ENTRY: '/custom/entrypoint.js' } as NodeJS.ProcessEnv,
      exists: (filePath) => filePath === '/custom/entrypoint.js',
    });

    expect(spec).toEqual({
      command: process.execPath,
      args: ['/custom/entrypoint.js', '--stdio'],
      source: 'env',
      entryPath: '/custom/entrypoint.js',
    });
  });

  it('falls back to the repo-local dynatrader smart entrypoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-'));
    const repoRoot = join(dir, 'repo');
    const terminalRoot = join(repoRoot, 'packages', 'terminal', 'packages', 'core');
    const dynatraderDir = join(repoRoot, 'packages', 'dynatrader');
    mkdirSync(terminalRoot, { recursive: true });
    mkdirSync(dynatraderDir, { recursive: true });
    writeFileSync(join(dynatraderDir, 'dynatrader.mjs'), '// fake entry');

    const spec = resolveDynatraderLaunchSpec({
      cwd: terminalRoot,
      env: {},
    });

    expect(spec.source).toBe('repo-mjs');
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(join(dynatraderDir, 'dynatrader.mjs'));
    expect(spec.args[1]).toBe('--stdio');
  });

  it('skips a stale DYNATRADER_ENTRY and falls back to repo-local entrypoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-stale-'));
    const repoRoot = join(dir, 'repo');
    const terminalRoot = join(repoRoot, 'packages', 'terminal', 'packages', 'core');
    const dynatraderEntry = join(repoRoot, 'packages', 'dynatrader', 'dynatrader.mjs');
    mkdirSync(terminalRoot, { recursive: true });

    const spec = resolveDynatraderLaunchSpec({
      cwd: terminalRoot,
      env: { DYNATRADER_ENTRY: join(repoRoot, 'missing', 'entrypoint.js') } as NodeJS.ProcessEnv,
      exists: (filePath) => filePath === dynatraderEntry,
    });

    expect(spec).toEqual({
      command: process.execPath,
      args: [dynatraderEntry, '--stdio'],
      source: 'repo-mjs',
      entryPath: dynatraderEntry,
    });
  });

  it('finds the bundled runtime from the Terminal module when cwd is a user workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-module-'));
    const repoRoot = join(dir, 'repo');
    const terminalModuleDir = join(
      repoRoot,
      'packages',
      'terminal',
      'packages',
      'core',
      'dist',
      'core'
    );
    const dynatraderEntry = join(repoRoot, 'packages', 'dynatrader', 'dynatrader.mjs');
    mkdirSync(terminalModuleDir, { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'dynatrader'), { recursive: true });
    writeFileSync(dynatraderEntry, '// fake entry');

    const spec = resolveDynatraderLaunchSpec({
      cwd: join(dir, 'a-user-workspace'),
      moduleDir: terminalModuleDir,
      env: {},
    });

    expect(spec).toMatchObject({
      command: process.execPath,
      args: [dynatraderEntry, '--stdio'],
      source: 'repo-mjs',
    });
  });

  it('prefers the workspace dir from the environment when cwd is elsewhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-workspace-'));
    const repoRoot = join(dir, 'repo');
    const workspaceRoot = join(repoRoot, 'workspaces', 'trading');
    const dynatraderEntry = join(repoRoot, 'packages', 'dynatrader', 'dynatrader.mjs');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'dynatrader'), { recursive: true });
    writeFileSync(dynatraderEntry, '// fake entry');

    const spec = resolveDynatraderLaunchSpec({
      cwd: join(dir, 'somewhere-else'),
      env: {
        DYNAMIND_WORKSPACE_DIR: workspaceRoot,
      } as NodeJS.ProcessEnv,
    });

    expect(spec).toMatchObject({
      command: process.execPath,
      args: [dynatraderEntry, '--stdio'],
      source: 'repo-mjs',
    });
  });
});
