import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  SkillRuntime,
  type SkillRuntimeOptions,
  type SkillDescriptor,
  type SandboxConstraints,
} from './skill-runtime';
import { AuditTrail } from '@dyna/audit';
import { AuthRuntime } from '@dyna/auth-runtime';
import { PermissionRuntime } from '@dyna/permission-runtime';

// --------------------------------------------------------------------------
// Mock EventBus -- avoid requiring the real emittery dependency
// --------------------------------------------------------------------------

const mockEventBus = {
  emit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnValue(() => {}),
  once: vi.fn().mockReturnValue(() => {}),
  off: vi.fn(),
  clearHistory: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  getStats: vi.fn().mockReturnValue({ totalEvents: 0, eventsByType: {} }),
  setMaxHistorySize: vi.fn(),
  emitBatch: vi.fn().mockResolvedValue(undefined),
};

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

const AUTH_CONFIG = {
  version: '1.0',
  owner: { id: 'owner-1', role: 'owner' },
  channels: {
    cli: { enabled: true, allowed_users: ['owner-1', 'subagent-1'] },
    web: { enabled: true, allowed_users: ['owner-1'] },
  },
  roles: {
    owner: { permissions: ['*'] },
    operator: { permissions: ['skill:execute:*', 'tool:read'] },
  },
  approval_required_for: ['trade:execute'],
  blocked_operations: [],
};

function makeSkillJson(
  name: string,
  overrides: Record<string, unknown> = {},
): string {
  const defaults: Record<string, unknown> = {
    name,
    version: '1.0.0',
    description: 'A test skill',
    status: 'validated',
    allowedModes: ['research', 'backtest', 'paper'],
    permissions: { allow: ['tool:read', 'tool:analyze'], deny: ['trade:execute'] },
    toolsRequired: ['tool:read'],
    riskLevel: 'low',
    inputs: { type: 'object' },
    outputs: { type: 'object' },
    review: { humanRequired: false, testsRequired: true, signatureRequired: false },
    security: {
      allowNetwork: false,
      allowFilesystem: true,
      allowCredentials: false,
      allowOrderExecution: false,
    },
  };
  const merged = { ...defaults, ...overrides };
  // Ensure name in JSON matches the passed name even if overrides passes a different name
  merged.name = name;
  return JSON.stringify(merged, null, 2);
}

const SKILL_MD = '# Test Skill\n\nThis skill does analysis.\n';

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-runtime-test-'));
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
  return dir;
}

async function writeSkill(
  workspaceDir: string,
  name: string,
  jsonContent: string,
  mdContent: string,
): Promise<void> {
  const skillDir = path.join(workspaceDir, 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'skill.json'), jsonContent, 'utf-8');
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), mdContent, 'utf-8');
}

function createRuntime(workspacePath: string): SkillRuntime {
  const authRuntime = new AuthRuntime(AUTH_CONFIG);
  const permissionRuntime = new PermissionRuntime(AUTH_CONFIG, workspacePath);
  const auditTrail = new AuditTrail(workspacePath);

  const options: SkillRuntimeOptions = {
    workspacePath,
    authRuntime,
    permissionRuntime,
    auditTrail,
    eventBus: mockEventBus as any,
    strictMode: false,
  };

  return new SkillRuntime(options);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('SkillRuntime', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceDir = await createTempWorkspace();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  // ----------------------------------------------------------------------
  // loadSkills
  // ----------------------------------------------------------------------

  it('loadSkills returns empty array when skills directory does not exist', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-skills-'));
    try {
      const runtime = createRuntime(emptyDir);
      const skills = await runtime.loadSkills();
      expect(skills).toEqual([]);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('loadSkills loads valid skills from workspace/skills/', async () => {
    await writeSkill(workspaceDir, 'alpha', makeSkillJson('alpha', { description: 'Alpha skill' }), SKILL_MD);
    await writeSkill(workspaceDir, 'beta', makeSkillJson('beta', { description: 'Beta skill' }), SKILL_MD);

    const runtime = createRuntime(workspaceDir);
    const skills = await runtime.loadSkills();

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(skills.find((s) => s.name === 'alpha')?.description).toBe('Alpha skill');
    expect(skills.find((s) => s.name === 'beta')?.description).toBe('Beta skill');
  });

  it('loadSkills skips directories missing SKILL.md', async () => {
    const skillDir = path.join(workspaceDir, 'skills', 'partial');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'skill.json'), makeSkillJson('partial'), 'utf-8');

    await writeSkill(workspaceDir, 'valid', makeSkillJson('valid'), SKILL_MD);

    const runtime = createRuntime(workspaceDir);
    const skills = await runtime.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('valid');
  });

  it('loadSkills skips directories with invalid JSON', async () => {
    await writeSkill(workspaceDir, 'bad', '{ invalid json }', SKILL_MD);
    await writeSkill(workspaceDir, 'good', makeSkillJson('good'), SKILL_MD);

    const runtime = createRuntime(workspaceDir);
    const skills = await runtime.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('good');
  });

  it('loadSkills skips directories failing schema validation', async () => {
    // Missing required field "version"
    await writeSkill(workspaceDir, 'bad-schema', JSON.stringify({ name: 'bad-schema', description: 'x' }), SKILL_MD);
    await writeSkill(workspaceDir, 'good', makeSkillJson('good'), SKILL_MD);

    const runtime = createRuntime(workspaceDir);
    const skills = await runtime.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('good');
  });

  // ----------------------------------------------------------------------
  // getLoadedSkills / getSkill
  // ----------------------------------------------------------------------

  it('getLoadedSkills returns all loaded skills after loadSkills', async () => {
    await writeSkill(workspaceDir, 'alpha', makeSkillJson('alpha'), SKILL_MD);

    const runtime = createRuntime(workspaceDir);
    expect(runtime.getLoadedSkills()).toHaveLength(0);

    await runtime.loadSkills();
    expect(runtime.getLoadedSkills()).toHaveLength(1);
  });

  it('getSkill returns undefined for unknown skill', () => {
    const runtime = createRuntime(workspaceDir);
    expect(runtime.getSkill('nonexistent')).toBeUndefined();
  });

  // ----------------------------------------------------------------------
  // validateSkill
  // ----------------------------------------------------------------------

  it('validateSkill returns error for unloaded skill', () => {
    const runtime = createRuntime(workspaceDir);
    const errors = runtime.validateSkill('unknown', 'research');
    expect(errors).toContain('Skill "unknown" not found or not loaded');
  });

  it('validateSkill returns error for deprecated skill', async () => {
    await writeSkill(workspaceDir, 'old', makeSkillJson('old', { status: 'deprecated' }), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const errors = runtime.validateSkill('old', 'research');
    expect(errors).toContain('Skill "old" is deprecated');
  });

  it('validateSkill returns error when mode is not allowed', async () => {
    await writeSkill(workspaceDir, 'research-only', makeSkillJson('research-only', { allowedModes: ['research'] }), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const errors = runtime.validateSkill('research-only', 'live');
    expect(errors.some((e) => e.includes('does not allow mode'))).toBe(true);
  });

  it('validateSkill returns error when human review is required in paper+ mode', async () => {
    await writeSkill(
      workspaceDir,
      'needs-review',
      makeSkillJson('needs-review', {
        review: { humanRequired: true, testsRequired: false, signatureRequired: false },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const errors = runtime.validateSkill('needs-review', 'paper');
    expect(errors.some((e) => e.includes('human review'))).toBe(true);
  });

  it('validateSkill returns error when signature is required', async () => {
    await writeSkill(
      workspaceDir,
      'signed',
      makeSkillJson('signed', {
        review: { humanRequired: false, testsRequired: false, signatureRequired: true },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const errors = runtime.validateSkill('signed', 'research');
    expect(errors.some((e) => e.includes('cryptographic signature'))).toBe(true);
  });

  it('validateSkill returns empty when everything is valid', async () => {
    await writeSkill(workspaceDir, 'ok', makeSkillJson('ok'), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const errors = runtime.validateSkill('ok', 'backtest');
    expect(errors).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // getSandboxConstraints
  // ----------------------------------------------------------------------

  it('getSandboxConstraints returns default constraints for unknown skill', () => {
    const runtime = createRuntime(workspaceDir);
    const c = runtime.getSandboxConstraints('unknown', 'research');
    expect(c.allowNetwork).toBe(false);
    expect(c.allowFilesystem).toBe(false);
    expect(c.allowCredentials).toBe(false);
    expect(c.allowOrderExecution).toBe(false);
    expect(c.allowedTools).toEqual([]);
    expect(c.deniedTools).toEqual([]);
    expect(c.allowedModes).toEqual([]);
  });

  it('getSandboxConstraints respects skill security block', async () => {
    await writeSkill(
      workspaceDir,
      'secure',
      makeSkillJson('secure', {
        security: { allowNetwork: true, allowFilesystem: false, allowCredentials: true, allowOrderExecution: false },
        permissions: { allow: ['tool:a', 'tool:b'], deny: ['tool:c'] },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const c = runtime.getSandboxConstraints('secure', 'research');
    expect(c.allowNetwork).toBe(true);
    expect(c.allowFilesystem).toBe(false);
    expect(c.allowCredentials).toBe(true);
    // allowOrderExecution is always overridden to false for safety
    expect(c.allowOrderExecution).toBe(false);
    expect(c.allowedTools).toEqual(['tool:a', 'tool:b']);
    expect(c.deniedTools).toEqual(['tool:c']);
  });

  it('getSandboxConstraints denies network in high-risk modes', async () => {
    await writeSkill(
      workspaceDir,
      'highrisk',
      makeSkillJson('highrisk', {
        security: { allowNetwork: true, allowFilesystem: false, allowCredentials: false, allowOrderExecution: false },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const c = runtime.getSandboxConstraints('highrisk', 'live');
    expect(c.allowNetwork).toBe(false);
  });

  it('getSandboxConstraints allows filesystem only in research mode', async () => {
    await writeSkill(
      workspaceDir,
      'fs-skill',
      makeSkillJson('fs-skill', {
        security: { allowNetwork: false, allowFilesystem: true, allowCredentials: false, allowOrderExecution: false },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const researchConstraints = runtime.getSandboxConstraints('fs-skill', 'research');
    expect(researchConstraints.allowFilesystem).toBe(true);

    const liveConstraints = runtime.getSandboxConstraints('fs-skill', 'live');
    expect(liveConstraints.allowFilesystem).toBe(false);
  });

  // ----------------------------------------------------------------------
  // execute
  // ----------------------------------------------------------------------

  it('execute returns error for unloaded skill', async () => {
    const runtime = createRuntime(workspaceDir);
    const result = await runtime.execute({
      skillName: 'ghost',
      input: {},
      context: { mode: 'research', actor: 'owner-1', actorType: 'user', correlationId: 'corr-1' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not loaded');
  });

  it('execute returns error when validation fails', async () => {
    await writeSkill(workspaceDir, 'bad-mode', makeSkillJson('bad-mode', { allowedModes: ['research'] }), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'bad-mode',
      input: {},
      context: { mode: 'live', actor: 'owner-1', actorType: 'user', correlationId: 'corr-1' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not allow mode');
  });

  it('execute succeeds for a valid skill', async () => {
    await writeSkill(workspaceDir, 'good-skill', makeSkillJson('good-skill'), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'good-skill',
      input: { query: 'analyze market' },
      context: { mode: 'research', actor: 'owner-1', actorType: 'user', correlationId: 'corr-1' },
    });

    expect(result.success).toBe(true);
    expect(result.skillName).toBe('good-skill');
    expect(result.output).toBeDefined();
    expect(result.output['skillName']).toBe('good-skill');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('execute blocks denied tools', async () => {
    await writeSkill(
      workspaceDir,
      'blocked',
      makeSkillJson('blocked', {
        permissions: { allow: ['tool:read'], deny: ['trade:execute'] },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'blocked',
      input: { tool: 'trade:execute' },
      context: { mode: 'research', actor: 'owner-1', actorType: 'user', correlationId: 'corr-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('denied tool');
  });

  it('execute blocks credentials when not allowed', async () => {
    await writeSkill(
      workspaceDir,
      'no-cred',
      makeSkillJson('no-cred', {
        security: { allowNetwork: false, allowFilesystem: false, allowCredentials: false, allowOrderExecution: false },
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'no-cred',
      input: {},
      credentials: { API_KEY: 'secret' },
      context: { mode: 'research', actor: 'owner-1', actorType: 'user', correlationId: 'corr-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('credentials');
  });

  it('execute produces an audit event ID on success', async () => {
    await writeSkill(workspaceDir, 'audit-test', makeSkillJson('audit-test'), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'audit-test',
      input: {},
      context: { mode: 'backtest', actor: 'owner-1', actorType: 'user', correlationId: 'corr-2' },
    });

    expect(result.success).toBe(true);
    expect(result.auditEventId).toBeDefined();
    expect(result.auditEventId.length).toBeGreaterThan(0);
  });

  it('execute rejects tool not in allowed list', async () => {
    await writeSkill(
      workspaceDir,
      'allowlist',
      makeSkillJson('allowlist', {
        permissions: { allow: ['tool:read'], deny: [] },
        toolsRequired: ['tool:read'],
      }),
      SKILL_MD,
    );
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    const result = await runtime.execute({
      skillName: 'allowlist',
      input: { tools: ['tool:write'] },
      context: { mode: 'research', actor: 'owner-1', actorType: 'user', correlationId: 'corr-3' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in the allowed list');
  });

  it('execute calls eventBus.emit on success', async () => {
    await writeSkill(workspaceDir, 'emit-test', makeSkillJson('emit-test'), SKILL_MD);
    const runtime = createRuntime(workspaceDir);
    await runtime.loadSkills();

    await runtime.execute({
      skillName: 'emit-test',
      input: {},
      context: { mode: 'backtest', actor: 'owner-1', actorType: 'user', correlationId: 'corr-4' },
    });

    expect(mockEventBus.emit).toHaveBeenCalledOnce();
    const callArg = mockEventBus.emit.mock.calls[0]!;
    expect(callArg[0]).toBe('agent');
    expect(callArg[1]!.type).toBe('skill_execution_completed');
    expect(callArg[1]!.data.skillName).toBe('emit-test');
  });
});
