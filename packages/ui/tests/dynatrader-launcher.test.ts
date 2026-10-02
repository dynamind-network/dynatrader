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

  it('finds the runtime in the current CLI package layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-'));
    const repoRoot = join(dir, 'repo');
    const cliRuntime = join(repoRoot, 'packages', 'cli', 'dist', 'entry', 'stdio.js');
    const terminalRoot = join(repoRoot, 'packages', 'ui', 'src');
    mkdirSync(terminalRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'cli', 'dist', 'entry'), { recursive: true });
    writeFileSync(cliRuntime, '// fake entry');

    const spec = resolveDynatraderLaunchSpec({
      cwd: terminalRoot,
      env: {},
    });

    expect(spec.source).toBe('repo-dist');
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(cliRuntime);
    expect(spec.args[1]).toBe('--stdio');
  });

  it('skips a stale DYNATRADER_ENTRY and falls back to the current CLI package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-stale-'));
    const repoRoot = join(dir, 'repo');
    const terminalRoot = join(repoRoot, 'packages', 'ui', 'src');
    const cliRuntime = join(repoRoot, 'packages', 'cli', 'dist', 'entry', 'stdio.js');
    mkdirSync(terminalRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'cli', 'dist', 'entry'), { recursive: true });
    writeFileSync(cliRuntime, '// fake entry');

    const spec = resolveDynatraderLaunchSpec({
      cwd: terminalRoot,
      env: { DYNATRADER_ENTRY: join(repoRoot, 'missing', 'entrypoint.js') } as NodeJS.ProcessEnv,
    });

    expect(spec).toEqual({
      command: process.execPath,
      args: [cliRuntime, '--stdio'],
      source: 'repo-dist',
      entryPath: cliRuntime,
    });
  });

  it('finds the CLI package runtime from its module when cwd is a user workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-module-'));
    const repoRoot = join(dir, 'repo');
    const uiModuleDir = join(repoRoot, 'packages', 'ui', 'dist');
    const cliRuntime = join(repoRoot, 'packages', 'cli', 'dist', 'entry', 'stdio.js');
    mkdirSync(join(repoRoot, 'packages', 'cli', 'dist', 'entry'), { recursive: true });
    writeFileSync(cliRuntime, '// fake entry');
    mkdirSync(uiModuleDir, { recursive: true });

    const spec = resolveDynatraderLaunchSpec({
      cwd: join(dir, 'a-user-workspace'),
      moduleDir: uiModuleDir,
      env: {},
    });

    expect(spec).toMatchObject({
      command: process.execPath,
      args: [cliRuntime, '--stdio'],
      source: 'repo-dist',
    });
  });

  it('ignores stale root and legacy package dist bundles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynatrader-launcher-workspace-'));
    const repoRoot = join(dir, 'repo');
    const workspaceRoot = join(repoRoot, 'workspaces', 'trading');
    const oldEntries = new Set([
      join(repoRoot, 'dist', 'entry', 'stdio.js'),
      join(repoRoot, 'packages', 'dynatrader', 'dist', 'entry', 'stdio.js'),
      join(repoRoot, 'packages', 'dynatrader', 'dynatrader.mjs'),
    ]);
    const probed: string[] = [];
    mkdirSync(workspaceRoot, { recursive: true });

    const spec = resolveDynatraderLaunchSpec({
      cwd: join(dir, 'somewhere-else'),
      moduleDir: join(dir, 'module'),
      env: { DYNAMIND_WORKSPACE_DIR: workspaceRoot } as NodeJS.ProcessEnv,
      exists: (filePath) => {
        probed.push(filePath);
        return oldEntries.has(filePath);
      },
    });

    expect(spec).toMatchObject({
      command: 'dynatrader',
      args: ['--stdio'],
      source: 'binary',
    });
    expect(probed).not.toContain(join(repoRoot, 'dist', 'entry', 'stdio.js'));
    expect(probed).not.toContain(join(repoRoot, 'packages', 'dynatrader', 'dist', 'entry', 'stdio.js'));
  });
});
