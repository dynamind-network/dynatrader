import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AgentRegistry, AgentNotFoundError, NoAgentsLoadedError } from './agent-registry';

// ---------------------------------------------------------------------------
// Helpers — the registry expects directories with profile.yaml + SOUL.md
// ---------------------------------------------------------------------------

function createTempWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-registry-test-'));
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  writeFileSync(
    path.join(dir, 'IDENTITY.md'),
    `---\nname: test-agent\nrole: Primary workspace agent\n---\n\n# Identity\n`,
    'utf-8',
  );
  return dir;
}

function writeAgentDir(workspaceDir: string, dirName: string, profile: Record<string, unknown>, soulContent: string): string {
  const agentDir = path.join(workspaceDir, 'agents', dirName);
  mkdirSync(agentDir, { recursive: true });
  const profileYaml = Object.entries(profile)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((i: string) => `  - ${i}`).join('\n')}`;
      }
      if (typeof v === 'object' && v !== null) {
        return `${k}:\n${Object.entries(v as Record<string, unknown>)
          .map(([sk, sv]) => {
            if (Array.isArray(sv)) {
              return `  ${sk}:\n${(sv as string[]).map((i: string) => `    - ${i}`).join('\n')}`;
            }
            return `  ${sk}: ${sv}`;
          })
          .join('\n')}`;
      }
      return `${k}: ${v}`;
    })
    .join('\n');
  writeFileSync(path.join(agentDir, 'profile.yaml'), profileYaml, 'utf-8');
  writeFileSync(path.join(agentDir, 'SOUL.md'), soulContent, 'utf-8');
  return agentDir;
}

function writeProfilesYaml(workspaceDir: string, yamlContent: string): void {
  writeFileSync(path.join(workspaceDir, 'profiles.yaml'), yamlContent, 'utf-8');
}

/** Minimal valid agent directory */
function minimalAgentDir(name: string): { dirName: string; profile: Record<string, unknown>; soul: string } {
  return {
    dirName: name,
    profile: {
      id: name,
      version: '1.0.0',
      description: 'A test agent',
      roles: [name],
      tools: ['tool-a'],
      outputs: ['Observation'],
      approvalRequiredFor: [],
      permissions: {
        allow: ['read_data'],
        deny: [],
      },
    },
    soul: '# Agent Instructions\n\nDo the thing.',
  };
}

function agentDirWithAllFields(name: string): { dirName: string; profile: Record<string, unknown>; soul: string } {
  return {
    dirName: name,
    profile: {
      id: name,
      version: '2.1.0',
      description: 'Full-featured test agent',
      tools: ['market-data', 'analysis-tool'],
      outputs: ['Observation', 'Hypothesis', 'SkillManifest'],
      approvalRequiredFor: ['live_trading', 'risk_changes'],
      permissions: {
        allow: ['read_market', 'write_memory'],
        deny: ['execute_orders'],
        riskLevel: 'high',
        allowedModes: ['research', 'backtest', 'paper'],
      },
    },
    soul: '## Instructions\n\nThis agent does advanced analysis.\n\n### Steps\n1. Analyze\n2. Conclude',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRegistry', () => {
  let workspaceDir: string;
  let registry: AgentRegistry;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    registry = new AgentRegistry(workspaceDir);
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Load and discover agents
  // -----------------------------------------------------------------------

  it('should load agents from workspace/agents/* directories', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);
    writeAgentDir(workspaceDir, 'beta', minimalAgentDir('beta').profile as Record<string, string>, minimalAgentDir('beta').soul);

    // Registry always loads main agent from profiles.yaml + directory agents
    expect(await registry.has('alpha')).toBe(true);
    expect(await registry.has('beta')).toBe(true);
    expect(await registry.has('test-agent')).toBe(true); // main agent from IDENTITY.md
  });

  it('discovers project agents in DynaTrader app data and reads both agent frontmatter formats', async () => {
    const projectAgents = path.join(workspaceDir, '.dynamind', 'agents');
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(path.join(projectAgents, 'researcher.md'), [
      '---',
      'name: researcher',
      'description: Project researcher',
      'mode: subagent',
      'permission:',
      '  web_search: allow',
      '  write: deny',
      'agent:',
      '  maxTurns: 12',
      '---',
      'Research carefully.',
    ].join('\n'), 'utf-8');
    const projectRegistry = new AgentRegistry(workspaceDir, [projectAgents]);

    const agent = await projectRegistry.find('researcher');
    expect(agent?.description).toBe('Project researcher');
    expect(agent?.instructions).toBe('Research carefully.');
    expect(agent?.tools.allow).toContain('web_search');
    expect(agent?.tools.deny).toContain('write');
    expect(agent?.maxTurns).toBe(12);
  });

  it('should resolve subagents from role selectors when configured', async () => {
    writeAgentDir(workspaceDir, 'risk-worker-a', {
      ...minimalAgentDir('risk-worker-a').profile,
      roles: ['risk-assessment'],
    }, minimalAgentDir('risk-worker-a').soul);
    writeAgentDir(workspaceDir, 'risk-worker-b', {
      ...minimalAgentDir('risk-worker-b').profile,
      roles: ['risk-assessment'],
    }, minimalAgentDir('risk-worker-b').soul);
    writeAgentDir(workspaceDir, 'risk-manager', {
      ...minimalAgentDir('risk-manager').profile,
      id: 'risk-manager',
      subagents: {
        allowRoles: ['risk-assessment'],
      },
    }, minimalAgentDir('risk-manager').soul);

    const riskManager = await registry.get('risk-manager');
    expect(riskManager.subagents).toContain('risk-worker-a');
    expect(riskManager.subagents).toContain('risk-worker-b');
  });

  it('should resolve parent-child hierarchy from profiles.yaml', async () => {
    writeProfilesYaml(
      workspaceDir,
      `main:
  name: test-agent
  description: Primary workspace agent
  subagents:
    allowAgents:
      - research-manager

subagents:
  - name: research-manager
    description: Research lead
    type: manager
  - name: research-worker
    description: Research worker
    reportsTo: research-manager
`,
    );

    const reg = new AgentRegistry(workspaceDir);
    const main = await reg.get('test-agent');
    const manager = await reg.get('research-manager');
    const worker = await reg.get('research-worker');

    expect(main.subagents).toContain('research-manager');
    expect(manager.subagents).toContain('research-worker');
    expect(worker.reportsTo).toBe('research-manager');
    expect(manager.type).toBe('manager');
  });

  it('should resolve nested profile hierarchies from profiles.yaml', async () => {
    writeProfilesYaml(
      workspaceDir,
      `main:
  name: test-agent
  description: Primary workspace agent
  subagents:
    allowAgents:
      - research-manager

subagents:
  - name: research-manager
    description: Research lead
    type: manager
    children:
      - name: research-worker
        description: Research worker
        reportsTo: research-manager
`,
    );

    const reg = new AgentRegistry(workspaceDir);
    const manager = await reg.get('research-manager');
    const worker = await reg.get('research-worker');

    expect(manager.subagents).toContain('research-worker');
    expect(worker.reportsTo).toBe('research-manager');
    expect(worker.type).toBe('leaf');
  });

  it('should read hierarchy metadata from directory IDENTITY.md frontmatter', async () => {
    const agentDir = writeAgentDir(
      workspaceDir,
      'frontmatter-agent',
      minimalAgentDir('frontmatter-agent').profile as Record<string, string>,
      minimalAgentDir('frontmatter-agent').soul,
    );
    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `---\nteam: alpha-research\nreportsTo: test-agent\ntype: leaf\n---\n\n# Identity\n`,
      'utf-8',
    );

    const reg = new AgentRegistry(workspaceDir);
    const agent = await reg.get('frontmatter-agent');
    expect(agent.team).toBe('alpha-research');
    expect(agent.reportsTo).toBe('test-agent');
    expect(agent.type).toBe('leaf');
    expect((await reg.get('test-agent')).subagents).toContain('frontmatter-agent');
  });

  it('should skip non-agent directories (no profile.yaml)', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);
    // Create a directory without profile.yaml
    mkdirSync(path.join(workspaceDir, 'agents', 'not-an-agent'), { recursive: true });
    writeFileSync(path.join(workspaceDir, 'agents', 'not-an-agent', 'random.txt'), 'ignored', 'utf-8');

    // Main agent (1) + alpha (1) = 2 total
    expect(await registry.count()).toBe(2);
    expect(await registry.has('alpha')).toBe(true);
  });

  it('should skip directories without valid profile.yaml', async () => {
    writeAgentDir(workspaceDir, 'valid', minimalAgentDir('valid').profile as Record<string, string>, minimalAgentDir('valid').soul);
    // Directory with profile but no SOUL.md
    const noSoulDir = path.join(workspaceDir, 'agents', 'no-soul');
    mkdirSync(noSoulDir, { recursive: true });
    writeFileSync(path.join(noSoulDir, 'profile.yaml'), 'id: no-soul\nversion: 1.0.0', 'utf-8');

    // Main agent (1) + valid (1) = 2 total
    expect(await registry.count()).toBe(2);
    expect(await registry.has('valid')).toBe(true);
  });

  it('should return only main agent when agents/ directory does not exist', async () => {
    rmSync(path.join(workspaceDir, 'agents'), { recursive: true, force: true });

    const reg = new AgentRegistry(workspaceDir);
    // Main agent from profiles.yaml is always loaded
    expect(await reg.count()).toBe(1);
    expect(await reg.has('test-agent')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Lookup by name
  // -----------------------------------------------------------------------

  it('should look up an agent by name with get()', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);

    const agent = await registry.get('alpha');
    expect(agent.name).toBe('alpha');
    expect(agent.version).toBe('1.0.0');
    expect(agent.description).toBe('A test agent');
  });

  it('should throw AgentNotFoundError when get() finds no match', async () => {
    await expect(registry.get('nonexistent')).rejects.toThrow(AgentNotFoundError);
  });

  it('should return undefined from find() when agent is missing', async () => {
    expect(await registry.find('ghost')).toBeUndefined();
  });

  it('should find existing agent with find()', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);
    expect((await registry.find('alpha'))?.name).toBe('alpha');
  });

  // -----------------------------------------------------------------------
  // 3. Default agent
  // -----------------------------------------------------------------------

  it('should return the main agent as default', async () => {
    writeAgentDir(workspaceDir, 'beta', minimalAgentDir('beta').profile as Record<string, string>, minimalAgentDir('beta').soul);
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);

    const def = await registry.getDefault();
    // Main agent from profiles.yaml is always the default
    expect(def.name).toBe('test-agent');
  });

  it('should not inject wildcard subagents into the main agent manifest', async () => {
    const main = await registry.get('test-agent');
    expect(main.subagents).toEqual([]);
  });

  it('should return a specific default agent when requested by name', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);
    writeAgentDir(workspaceDir, 'beta', minimalAgentDir('beta').profile as Record<string, string>, minimalAgentDir('beta').soul);

    const def = await registry.getDefault('beta');
    expect(def.name).toBe('beta');
  });

  it('should always have at least one agent (main agent from profiles.yaml)', async () => {
    rmSync(path.join(workspaceDir, 'agents'), { recursive: true, force: true });
    const empty = new AgentRegistry(workspaceDir);
    // Main agent from profiles.yaml is always loaded
    expect(await empty.getDefault()).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 4. getAll and has
  // -----------------------------------------------------------------------

  it('should return all agents from getAll()', async () => {
    writeAgentDir(workspaceDir, 'a', { ...minimalAgentDir('agent-a').profile, id: 'agent-a' } as Record<string, string>, minimalAgentDir('agent-a').soul);
    writeAgentDir(workspaceDir, 'b', { ...minimalAgentDir('agent-b').profile, id: 'agent-b' } as Record<string, string>, minimalAgentDir('agent-b').soul);
    writeAgentDir(workspaceDir, 'c', { ...minimalAgentDir('agent-c').profile, id: 'agent-c' } as Record<string, string>, minimalAgentDir('agent-c').soul);

    const all = await registry.getAll();
    // Main agent (1) + 3 directory agents = 4 total
    expect(all).toHaveLength(4);
    const names = all.map((a) => a.name).sort();
    expect(names).toContain('agent-a');
    expect(names).toContain('agent-b');
    expect(names).toContain('agent-c');
    expect(names).toContain('test-agent');
  });

  it('should return correct has() result', async () => {
    writeAgentDir(workspaceDir, 'present', minimalAgentDir('present').profile as Record<string, string>, minimalAgentDir('present').soul);

    expect(await registry.has('present')).toBe(true);
    expect(await registry.has('absent')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Memoization (lazy load on first access)
  // -----------------------------------------------------------------------

  it('should memoize loading — agents discovered after first access are not included', async () => {
    // First access loads main agent from profiles.yaml
    const initialCount = await registry.count();
    writeAgentDir(workspaceDir, 'late', minimalAgentDir('late').profile as Record<string, string>, minimalAgentDir('late').soul);
    // Count should be same as initial (cached)
    expect(await registry.count()).toBe(initialCount);
  });

  it('should return cached results across multiple calls', async () => {
    writeAgentDir(workspaceDir, 'alpha', minimalAgentDir('alpha').profile as Record<string, string>, minimalAgentDir('alpha').soul);
    const c1 = await registry.count();
    const c2 = await registry.count();
    const c3 = await registry.count();
    // Main agent (1) + alpha (1) = 2
    expect(c1).toBe(2);
    expect(c2).toBe(2);
    expect(c3).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 6. Full manifest parsing (all fields)
  // -----------------------------------------------------------------------

  it('should parse all manifest fields correctly', async () => {
    const full = agentDirWithAllFields('full-agent');
    writeAgentDir(workspaceDir, 'full-agent', full.profile as Record<string, string>, full.soul);

    const agent = await registry.get('full-agent');

    expect(agent.name).toBe('full-agent');
    expect(agent.version).toBe('2.1.0');
    expect(agent.description).toBe('Full-featured test agent');
    expect(agent.outputs).toEqual(['Observation', 'Hypothesis', 'SkillManifest']);
    expect(agent.approvalRequiredFor).toEqual(['live_trading', 'risk_changes']);
    expect(agent.instructions).toContain('This agent does advanced analysis.');
  });

  // -----------------------------------------------------------------------
  // 6b. Instructions body preservation
  // -----------------------------------------------------------------------

  it('should preserve the full markdown instructions body', async () => {
    const soul = '# My Agent\n\nThis is a **rich** markdown body.\n\n- list item 1\n- list item 2\n\n```typescript\nconst x = 1;\n```';
    writeAgentDir(workspaceDir, 'instruct-agent', {
      id: 'instruct-agent',
      allowedModes: ['research'],
      tools: [],
      outputs: [],
      approvalRequiredFor: [],
    } as unknown as Record<string, string>, soul);

    const agent = await registry.get('instruct-agent');
    expect(agent.instructions).toContain('# My Agent');
    expect(agent.instructions).toContain('**rich**');
    expect(agent.instructions).toContain('const x = 1;');
  });

  // -----------------------------------------------------------------------
  // 7. load() method forces eager loading
  // -----------------------------------------------------------------------

  it('should eagerly load via explicit load() call', async () => {
    writeAgentDir(workspaceDir, 'eager', minimalAgentDir('eager').profile as Record<string, string>, minimalAgentDir('eager').soul);
    await registry.load();
    expect(await registry.has('eager')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 8. Error types
  // -----------------------------------------------------------------------

  it('should produce AgentNotFoundError with agent name', () => {
    const err = new AgentNotFoundError('missing-agent');
    expect(err.message).toContain('missing-agent');
    expect(err.name).toBe('AgentNotFoundError');
  });

  it('should produce NoAgentsLoadedError with message', () => {
    const err = new NoAgentsLoadedError();
    expect(err.message).toContain('No agents have been loaded');
    expect(err.name).toBe('NoAgentsLoadedError');
  });

  // -----------------------------------------------------------------------
  // 9. Ephemeral subagent support
  // -----------------------------------------------------------------------

  it('should register and unregister ephemeral subagents', async () => {
    await registry.load();

    const ephemeral = registry.registerEphemeral('temp-worker', 'Do temporary work');
    expect(ephemeral.name).toBe('temp-worker');
    expect(ephemeral.instructions).toBe('Do temporary work');
    expect(ephemeral.reportsTo).toBe('test-agent');
    expect(await registry.has('temp-worker')).toBe(true);

    const removed = registry.unregisterEphemeral('temp-worker');
    expect(removed).toBe(true);
    expect(await registry.has('temp-worker')).toBe(false);
  });

  it('should include ephemeral subagents in getAll()', async () => {
    await registry.load();

    registry.registerEphemeral('worker-1', 'Task 1');
    registry.registerEphemeral('worker-2', 'Task 2');

    const all = await registry.getAll();
    const names = all.map((a) => a.name);
    expect(names).toContain('worker-1');
    expect(names).toContain('worker-2');
  });
});
