import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadConfig, loadProfiles } from './config';

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

describe('decision model config', () => {
  let workspaceDir = '';

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = '';
    }
  });

  it('loads provider-neutral decision model settings with opt-in defaults', async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'decision-config-test-'));
    writeFileSync(path.join(workspaceDir, 'config.yaml'), `decisionModels:
  enabled: true
  provider: typesafe
  model: jev-latest
  apiKeyEnv: TYPESAFE_API_KEY
  features:
    recovery: true
    completion: false
    commandRisk: true
`, 'utf-8');
    const config = await loadConfig(workspaceDir);
    expect(config.decisionModels).toMatchObject({
      enabled: true,
      provider: 'typesafe',
      model: 'jev-latest',
      features: { recovery: true, completion: false, commandRisk: true },
    });
  });

  it('keeps decision models disabled by default', async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'decision-config-default-'));
    writeFileSync(path.join(workspaceDir, 'config.yaml'), 'models:\n  provider: openai\n', 'utf-8');
    expect((await loadConfig(workspaceDir)).decisionModels?.enabled).toBe(false);
  });
});
