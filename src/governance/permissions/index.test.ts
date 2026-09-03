import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionRuntime } from './index';

function makeWorkspace(withUserProfile: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dyna-permission-'));
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      version: '1.0',
      owner: { id: 'operator', role: 'owner' },
      channels: {
        cli: { enabled: true, allowed_users: ['operator'] },
        web: { enabled: true, allowed_users: ['operator'] },
      },
      roles: {
        owner: { permissions: ['*'] },
        operator: { permissions: ['read_status', 'run_backtest', 'read_memory', 'write_memory'] },
      },
      approval_required_for: ['modify_risk_profile'],
      blocked_operations: ['withdraw_funds'],
    }, null, 2),
    'utf-8',
  );

  if (withUserProfile) {
    writeFileSync(path.join(dir, 'USER.md'), '# Trader profile', 'utf-8');
  }

  return dir;
}

describe('PermissionRuntime', () => {
  let workspaceDir: string;
  let runtime: PermissionRuntime;

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('denies high-risk modes when USER.md is missing from the workspace root', async () => {
    workspaceDir = makeWorkspace(false);
    runtime = new PermissionRuntime(
      {
        version: '1.0',
        owner: { id: 'operator', role: 'owner' },
        channels: {
          cli: { enabled: true, allowed_users: ['operator'] },
          web: { enabled: true, allowed_users: ['operator'] },
        },
        roles: {
          owner: { permissions: ['*'] },
          operator: { permissions: ['read_status', 'run_backtest', 'read_memory', 'write_memory'] },
        },
        approval_required_for: ['modify_risk_profile'],
        blocked_operations: ['withdraw_funds'],
      },
      workspaceDir,
    );

    const result = await runtime.checkPermission({
      actor: 'operator',
      actorType: 'user',
      action: 'run_paper_trade',
      mode: 'paper',
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('USER.md required for this mode');
  });

  it('allows high-risk modes when USER.md exists at the workspace root', async () => {
    workspaceDir = makeWorkspace(true);
    runtime = new PermissionRuntime(
      {
        version: '1.0',
        owner: { id: 'operator', role: 'owner' },
        channels: {
          cli: { enabled: true, allowed_users: ['operator'] },
          web: { enabled: true, allowed_users: ['operator'] },
        },
        roles: {
          owner: { permissions: ['*'] },
          operator: { permissions: ['run_paper_trade', 'read_status'] },
        },
        approval_required_for: ['modify_risk_profile'],
        blocked_operations: ['withdraw_funds'],
      },
      workspaceDir,
    );

    const result = await runtime.checkPermission({
      actor: 'operator',
      actorType: 'user',
      action: 'run_paper_trade',
      mode: 'paper',
    });

    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
