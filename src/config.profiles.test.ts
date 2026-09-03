import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadProfiles } from './config';

describe('loadProfiles', () => {
  let workspaceDir = '';

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = '';
    }
  });

  it('parses main hierarchy metadata and persistent subagents from profiles.yaml', async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'profiles-config-test-'));
    writeFileSync(
      path.join(workspaceDir, 'profiles.yaml'),
      `main:
  name: primary-agent
  description: Primary workspace agent
  type: manager
  team: alpha
  reportsTo: root
  roles:
    - coordinator
  heartbeat:
    every: 30m
  subagents:
    allowAgents:
      - research-lead

subagents:
  - name: research-lead
    description: Research lead
    parent: primary-agent
    type: manager
`,
      'utf-8',
    );

    const profiles = await loadProfiles(workspaceDir);

    expect(profiles.main.name).toBe('primary-agent');
    expect(profiles.main.description).toBe('Primary workspace agent');
    expect(profiles.main.type).toBe('manager');
    expect(profiles.main.team).toBe('alpha');
    expect(profiles.main.reportsTo).toBe('root');
    expect(profiles.main.roles).toEqual(['coordinator']);
    expect(profiles.main.heartbeat).toEqual({ every: '30m' });
    expect(profiles.main.subagents?.allowAgents).toEqual(['research-lead']);
    expect(profiles.subagents?.[0]?.name).toBe('research-lead');
    expect(profiles.subagents?.[0]?.type).toBe('manager');
    expect(profiles.subagents?.[0]?.parent).toBe('primary-agent');
  });
});
