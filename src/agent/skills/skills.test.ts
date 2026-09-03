/**
 * Tests for the Skill System.
 *
 * Covers: SkillLoader, SkillGates, SkillInjector, SkillWorkshop,
 * precedence ordering, YAML frontmatter parsing, and proposal lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SkillLoader } from './skill-loader';
import { SkillGates } from './skill-gates';
import { SkillInjector } from './skill-injector';
import { SkillWorkshop } from './skill-workshop';
import { PRECEDENCE_ORDER } from './skill-types';
import type { SkillMetadata, Skill, ConfigProvider, PrecedenceLevel } from './skill-types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for test fixtures. */
async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
}

/** Write a .skill.md file with YAML frontmatter + body. */
async function writeSkillFile(
  dir: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  const yamlLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}:\n${v.map((i) => `  - ${i}`).join('\n')}`;
    }
    if (typeof v === 'object' && v !== null) {
      return `${k}:\n${Object.entries(v)
        .map(([sk, sv]) => {
          if (Array.isArray(sv)) {
            if (sv.length === 0) return `  ${sk}: []`;
            return `  ${sk}:\n${sv.map((i) => `    - ${i}`).join('\n')}`;
          }
          return `  ${sk}: ${sv}`;
        })
        .join('\n')}`;
    }
    return `${k}: ${v}`;
  });

  const content = `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// SkillLoader Tests
// ---------------------------------------------------------------------------

describe('SkillLoader', () => {
  let tmpDir: string;
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    loader = new SkillLoader();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ----------------------------------------------------------------------
  // loadFromDirectory
  // ----------------------------------------------------------------------

  it('loadFromDirectory returns empty array when directory does not exist', async () => {
    const skills = await loader.loadFromDirectory('/nonexistent/path', 0);
    expect(skills).toEqual([]);
  });

  it('loadFromDirectory loads valid .skill.md files', async () => {
    await writeSkillFile(
      skillsDir,
      'trend.skill.md',
      { name: 'trend_following', description: 'Trend strategy', type: 'strategy', tags: ['trend'], confidence: 0.7 },
      'Follow the trend.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.name).toBe('trend_following');
    expect(skills[0]!.metadata.type).toBe('strategy');
    expect(skills[0]!.metadata.tags).toEqual(['trend']);
    expect(skills[0]!.metadata.confidence).toBe(0.7);
    expect(skills[0]!.instructions).toBe('Follow the trend.');
    expect(skills[0]!.precedence).toBe(0);
    expect(skills[0]!.source).toContain('trend.skill.md');
  });

  it('loadFromDirectory ignores files without .skill.md extension', async () => {
    await writeSkillFile(
      skillsDir,
      'readme.md',
      { name: 'ignored', description: 'Should be skipped', type: 'utility', tags: [] },
      'Nope.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(0);
  });

  it('loadFromDirectory skips files with invalid frontmatter', async () => {
    await fs.writeFile(path.join(skillsDir, 'bad.skill.md'), 'no frontmatter here', 'utf-8');

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(0);
  });

  it('loadFromDirectory skips files missing required fields (name)', async () => {
    await writeSkillFile(
      skillsDir,
      'noname.skill.md',
      { description: 'no name', type: 'utility', tags: [] },
      'Missing name field.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(0);
  });

  it('loadFromDirectory skips files with invalid type', async () => {
    await writeSkillFile(
      skillsDir,
      'badtype.skill.md',
      { name: 'bad', description: 'bad type', type: 'invalid_type', tags: [] },
      'Bad type.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(0);
  });

  it('loadFromDirectory parses requires block correctly', async () => {
    await writeSkillFile(
      skillsDir,
      'gated.skill.md',
      {
        name: 'gated_skill',
        description: 'Has requirements',
        type: 'analysis',
        tags: ['gated'],
        requires: { bins: ['python', 'node'], env: ['API_KEY'], config: ['maxRisk'] },
      },
      'Gated instructions.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.requires).toBeDefined();
    expect(skills[0]!.metadata.requires!.bins).toEqual(['python', 'node']);
    expect(skills[0]!.metadata.requires!.env).toEqual(['API_KEY']);
    expect(skills[0]!.metadata.requires!.config).toEqual(['maxRisk']);
  });

  it('loadFromDirectory parses OS filter correctly', async () => {
    await writeSkillFile(
      skillsDir,
      'os-specific.skill.md',
      { name: 'win_only', description: 'Windows only', type: 'utility', tags: [], os: ['win32'] },
      'Windows-specific instructions.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.os).toEqual(['win32']);
  });

  it('loadFromDirectory uses default confidence of 0.5 when not specified', async () => {
    await writeSkillFile(
      skillsDir,
      'default-conf.skill.md',
      { name: 'default_conf', description: 'No confidence set', type: 'utility', tags: [] },
      'Default confidence.',
    );

    const skills = await loader.loadFromDirectory(skillsDir, 0);
    expect(skills[0]!.metadata.confidence).toBe(0.5);
  });

  // ----------------------------------------------------------------------
  // loadAll
  // ----------------------------------------------------------------------

  it('loadAll loads from multiple precedence directories with override', async () => {
    const workspaceSkills = path.join(tmpDir, 'workspace', 'skills');
    const bundledSkills = path.join(tmpDir, 'bundled', 'skills');
    await fs.mkdir(workspaceSkills, { recursive: true });
    await fs.mkdir(bundledSkills, { recursive: true });

    // Bundled skill
    await writeSkillFile(
      bundledSkills,
      'ma_strategy.skill.md',
      { name: 'ma_strategy', description: 'Bundled MA strategy', type: 'strategy', tags: ['ma'] },
      'Bundled instructions.',
    );

    // Workspace skill with same name (should override)
    await writeSkillFile(
      workspaceSkills,
      'ma_strategy.skill.md',
      { name: 'ma_strategy', description: 'Overridden MA strategy', type: 'strategy', tags: ['ma'] },
      'Overridden instructions.',
    );

    loader.registerPath('workspace', path.join(tmpDir, 'workspace'));
    loader.registerPath('bundled', path.join(tmpDir, 'bundled'));

    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.description).toBe('Overridden MA strategy');
    expect(skills[0]!.instructions).toBe('Overridden instructions.');
    expect(skills[0]!.precedence).toBe(0); // workspace precedence
  });

  it('loadAll loads unique skills from multiple directories', async () => {
    const projectSkills = path.join(tmpDir, 'project', 'skills');
    const personalSkills = path.join(tmpDir, 'personal', 'skills');
    await fs.mkdir(projectSkills, { recursive: true });
    await fs.mkdir(personalSkills, { recursive: true });

    await writeSkillFile(
      projectSkills,
      'alpha.skill.md',
      { name: 'alpha', description: 'Project skill A', type: 'analysis', tags: ['a'] },
      'Alpha.',
    );

    await writeSkillFile(
      personalSkills,
      'beta.skill.md',
      { name: 'beta', description: 'Personal skill B', type: 'research', tags: ['b'] },
      'Beta.',
    );

    loader.registerPath('project', path.join(tmpDir, 'project'));
    loader.registerPath('personal', path.join(tmpDir, 'personal'));

    const skills = await loader.loadAll();
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.metadata.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('loadAll handles empty registrations gracefully', async () => {
    const skills = await loader.loadAll();
    expect(skills).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Query methods
  // ----------------------------------------------------------------------

  it('getSkillsByType filters correctly', async () => {
    await writeSkillFile(skillsDir, 'a.skill.md', { name: 'a', description: 'A', type: 'strategy', tags: [] }, 'A');
    await writeSkillFile(skillsDir, 'b.skill.md', { name: 'b', description: 'B', type: 'risk', tags: [] }, 'B');
    await writeSkillFile(skillsDir, 'c.skill.md', { name: 'c', description: 'C', type: 'strategy', tags: [] }, 'C');

    await loader.loadFromDirectory(skillsDir, 0);
    const strategies = loader.getSkillsByType('strategy');
    expect(strategies).toHaveLength(2);
    expect(strategies.every((s) => s.metadata.type === 'strategy')).toBe(true);
  });

  it('getSkillsByTag filters correctly', async () => {
    await writeSkillFile(skillsDir, 'a.skill.md', { name: 'a', description: 'A', type: 'utility', tags: ['foo', 'bar'] }, 'A');
    await writeSkillFile(skillsDir, 'b.skill.md', { name: 'b', description: 'B', type: 'utility', tags: ['bar', 'baz'] }, 'B');
    await writeSkillFile(skillsDir, 'c.skill.md', { name: 'c', description: 'C', type: 'utility', tags: ['foo'] }, 'C');

    await loader.loadFromDirectory(skillsDir, 0);
    const fooSkills = loader.getSkillsByTag('foo');
    expect(fooSkills).toHaveLength(2);
  });

  it('getSkill returns specific skill by name', async () => {
    await writeSkillFile(skillsDir, 'specific.skill.md', { name: 'specific', description: 'Specific skill', type: 'utility', tags: [] }, 'Specific.');

    await loader.loadFromDirectory(skillsDir, 0);
    const skill = loader.getSkill('specific');
    expect(skill).toBeDefined();
    expect(skill!.metadata.name).toBe('specific');
    expect(loader.getSkill('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SkillGates Tests
// ---------------------------------------------------------------------------

describe('SkillGates', () => {
  let gates: SkillGates;

  beforeEach(() => {
    gates = new SkillGates();
  });

  describe('checkOs', () => {
    it('passes when no OS filter is set', () => {
      const result = gates.checkOs(undefined);
      expect(result.passed).toBe(true);
    });

    it('passes when current platform is in allowed list', () => {
      const current = process.platform as 'win32' | 'darwin' | 'linux';
      const result = gates.checkOs([current]);
      expect(result.passed).toBe(true);
    });

    it('fails when current platform is not in allowed list', () => {
      const current = process.platform;
      const other = current === 'win32' ? 'linux' : 'win32';
      const result = gates.checkOs([other as 'win32' | 'darwin' | 'linux']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain(current);
    });
  });

  describe('checkEnv', () => {
    it('passes when no env vars are required', () => {
      const result = gates.checkEnv(undefined);
      expect(result.passed).toBe(true);
    });

    it('passes when all required env vars are set', () => {
      process.env['TEST_SKILL_VAR'] = 'present';
      const result = gates.checkEnv(['TEST_SKILL_VAR']);
      expect(result.passed).toBe(true);
    });

    it('fails when a required env var is missing', () => {
      delete process.env['TEST_SKILL_VAR'];
      const result = gates.checkEnv(['TEST_SKILL_VAR', 'NONEXISTENT_VAR_12345']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('NONEXISTENT_VAR_12345');
    });

    it('fails when env var is empty string', () => {
      process.env['EMPTY_VAR'] = '';
      const result = gates.checkEnv(['EMPTY_VAR']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('EMPTY_VAR');
    });
  });

  describe('checkBins', () => {
    it('passes when no bins are required', () => {
      const result = gates.checkBins(undefined);
      expect(result.passed).toBe(true);
    });

    it('passes when required bin exists on PATH', () => {
      // node should always be on PATH in a Node.js test environment
      const result = gates.checkBins(['node']);
      expect(result.passed).toBe(true);
    });

    it('fails when required bin does not exist', () => {
      const result = gates.checkBins(['nonexistent_binary_xyz123']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('nonexistent_binary_xyz123');
    });
  });

  describe('checkConfig', () => {
    it('passes when no config is required', () => {
      const result = gates.checkConfig(undefined);
      expect(result.passed).toBe(true);
    });

    it('passes when config provider has all keys', () => {
      const provider: ConfigProvider = {
        has: (key: string) => ['api.key', 'risk.max'].includes(key),
      };
      gates.setConfigProvider(provider);
      const result = gates.checkConfig(['api.key', 'risk.max']);
      expect(result.passed).toBe(true);
    });

    it('fails when config provider is missing', () => {
      const result = gates.checkConfig(['some.key']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No config provider');
    });

    it('fails when config key is missing', () => {
      const provider: ConfigProvider = { has: () => false };
      gates.setConfigProvider(provider);
      const result = gates.checkConfig(['missing.key']);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('missing.key');
    });
  });

  describe('evaluateAll', () => {
    it('passes a skill with no requirements', () => {
      const skill: Skill = {
        metadata: { name: 'simple', description: 'Simple', type: 'utility', tags: [] },
        instructions: 'Do stuff.',
        source: '/fake/path.skill.md',
        precedence: 0,
      };
      const result = gates.evaluateAll(skill);
      expect(result.passed).toBe(true);
    });

    it('fails a skill with unmet OS requirement', () => {
      const current = process.platform;
      const other = current === 'win32' ? 'linux' : 'win32';
      const skill: Skill = {
        metadata: {
          name: 'os_gated',
          description: 'OS gated',
          type: 'utility',
          tags: [],
          os: [other as 'win32' | 'darwin' | 'linux'],
        },
        instructions: '',
        source: '/fake.skill.md',
        precedence: 0,
      };
      const result = gates.evaluateAll(skill);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('blocked by gates');
    });

    it('fails a skill with missing binaries', () => {
      const skill: Skill = {
        metadata: {
          name: 'bin_gated',
          description: 'Bin gated',
          type: 'utility',
          tags: [],
          requires: { bins: ['nonexistent_binary_xyz'] },
        },
        instructions: '',
        source: '/fake.skill.md',
        precedence: 0,
      };
      const result = gates.evaluateAll(skill);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('blocked by gates');
    });
  });
});

// ---------------------------------------------------------------------------
// SkillInjector Tests
// ---------------------------------------------------------------------------

describe('SkillInjector', () => {
  let injector: SkillInjector;

  beforeEach(() => {
    injector = new SkillInjector();
  });

  it('returns empty string for empty skill list', () => {
    const context = injector.buildSkillContext([]);
    expect(context).toBe('');
  });

  it('builds correct XML format for a single skill', () => {
    const skills: Skill[] = [
      {
        metadata: {
          name: 'trend_following',
          description: 'Trend following strategy',
          type: 'strategy',
          tags: ['trend'],
        },
        instructions: 'Follow the moving average crossover.',
        source: '/test.skill.md',
        precedence: 0,
      },
    ];

    const xml = injector.buildSkillContext(skills);
    expect(xml).toContain('<available_skills>');
    expect(xml).toContain('</available_skills>');
    expect(xml).toContain('<skill name="trend_following" type="strategy">');
    expect(xml).toContain('<description>Trend following strategy</description>');
    expect(xml).toContain('Follow the moving average crossover.');
    expect(xml).toContain('</skill>');
  });

  it('builds XML for multiple skills sorted by precedence then name', () => {
    const skills: Skill[] = [
      {
        metadata: { name: 'beta', description: 'Beta', type: 'analysis', tags: [] },
        instructions: 'Beta instructions.',
        source: '/bundled/beta.skill.md',
        precedence: 3,
      },
      {
        metadata: { name: 'alpha', description: 'Alpha', type: 'strategy', tags: [] },
        instructions: 'Alpha instructions.',
        source: '/workspace/alpha.skill.md',
        precedence: 0,
      },
    ];

    const xml = injector.buildSkillContext(skills);
    // Alpha (precedence 0) should come before Beta (precedence 3)
    const alphaIdx = xml.indexOf('alpha');
    const betaIdx = xml.indexOf('beta');
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it('injectIntoPrompt appends to prompt without existing skills', () => {
    const prompt = 'You are a trading agent.';
    const context = '<available_skills>\n  <skill name="test" type="utility">\n    <description>Test</description>\n    <instructions>\n      Test instructions.\n    </instructions>\n  </skill>\n</available_skills>';

    const result = injector.injectIntoPrompt(prompt, context);
    expect(result).toContain(prompt);
    expect(result).toContain(context);
  });

  it('injectIntoPrompt replaces existing skill block', () => {
    const prompt = 'You are a trading agent.\n\n<available_skills>\n  <skill name="old" type="utility">\n    <description>Old</description>\n    <instructions>Old instructions.</instructions>\n  </skill>\n</available_skills>';
    const newContext = '<available_skills>\n  <skill name="new" type="analysis">\n    <description>New</description>\n    <instructions>New instructions.</instructions>\n  </skill>\n</available_skills>';

    const result = injector.injectIntoPrompt(prompt, newContext);
    expect(result).not.toContain('old');
    expect(result).toContain('new');
  });

  it('injectIntoPrompt returns original prompt when context is empty', () => {
    const prompt = 'You are a trading agent.';
    const result = injector.injectIntoPrompt(prompt, '');
    expect(result).toBe(prompt);
  });

  it('escapes XML special characters in skill content', () => {
    const skills: Skill[] = [
      {
        metadata: {
          name: 'test & verify',
          description: 'Description with <special> chars & stuff',
          type: 'utility',
          tags: [],
        },
        instructions: 'Use ATR < 2.0 && volume > 1000',
        source: '/test.skill.md',
        precedence: 0,
      },
    ];

    const xml = injector.buildSkillContext(skills);
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('<special>');
    expect(xml).toContain('&lt;special&gt;');
    expect(xml).toContain('ATR &lt; 2.0 &amp;&amp; volume');
  });
});

// ---------------------------------------------------------------------------
// SkillWorkshop Tests
// ---------------------------------------------------------------------------

describe('SkillWorkshop', () => {
  let tmpDir: string;
  let workshop: SkillWorkshop;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    workshop = new SkillWorkshop(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('proposeSkill creates a pending proposal', async () => {
    const proposal = await workshop.proposeSkill(
      { name: 'test_skill', description: 'A test skill', type: 'analysis', tags: ['test'] },
      'Do analysis.',
    );

    expect(proposal.id).toBeDefined();
    expect(proposal.metadata.name).toBe('test_skill');
    expect(proposal.status).toBe('pending');
    expect(proposal.createdAt).toBeGreaterThan(0);
    expect(proposal.updatedAt).toBeGreaterThan(0);
  });

  it('approveSkill changes status to approved', async () => {
    const proposal = await workshop.proposeSkill(
      { name: 'approve_me', description: 'Approve me', type: 'utility', tags: [] },
      'Utility stuff.',
    );

    const approved = await workshop.approveSkill(proposal.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe('approved');
    expect(approved!.updatedAt).toBeGreaterThan(proposal.createdAt);
  });

  it('approveSkill returns undefined for unknown ID', async () => {
    const result = await workshop.approveSkill('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('rejectSkill changes status to rejected with reason', async () => {
    const proposal = await workshop.proposeSkill(
      { name: 'reject_me', description: 'Reject me', type: 'risk', tags: [] },
      'Risky stuff.',
    );

    const rejected = await workshop.rejectSkill(proposal.id, 'Too risky without evidence');
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe('rejected');
    expect(rejected!.rejectionReason).toBe('Too risky without evidence');
  });

  it('rejectSkill returns undefined for unknown ID', async () => {
    const result = await workshop.rejectSkill('nonexistent-id', 'No reason');
    expect(result).toBeUndefined();
  });

  it('cannot approve or reject already-processed proposal', async () => {
    const proposal = await workshop.proposeSkill(
      { name: 'preprocessed', description: 'Already processed', type: 'strategy', tags: [] },
      'Done.',
    );

    await workshop.approveSkill(proposal.id);
    // Trying to reject an already approved proposal should not change it
    const rejected = await workshop.rejectSkill(proposal.id, 'Too late');
    expect(rejected!.status).toBe('approved');
    expect(rejected!.rejectionReason).toBeUndefined();
  });

  it('listProposals returns all proposals sorted newest first', async () => {
    const p1 = await workshop.proposeSkill(
      { name: 'first', description: 'First', type: 'strategy', tags: [] },
      'First.',
    );
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await workshop.proposeSkill(
      { name: 'second', description: 'Second', type: 'analysis', tags: [] },
      'Second.',
    );

    const all = await workshop.listProposals();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe(p2.id); // newest first
    expect(all[1]!.id).toBe(p1.id);
  });

  it('listProposals filters by status', async () => {
    const p1 = await workshop.proposeSkill(
      { name: 'pending_one', description: 'Pending', type: 'utility', tags: [] },
      'Pending.',
    );
    const p2 = await workshop.proposeSkill(
      { name: 'approve_one', description: 'Approve', type: 'utility', tags: [] },
      'Approve.',
    );
    await workshop.approveSkill(p2.id);

    const pending = await workshop.listProposals('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(p1.id);

    const approved = await workshop.listProposals('approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]!.id).toBe(p2.id);
  });

  it('getApprovedProposals and getPendingProposals work', async () => {
    await workshop.proposeSkill(
      { name: 'p1', description: 'P1', type: 'utility', tags: [] },
      'P1.',
    );
    const p2 = await workshop.proposeSkill(
      { name: 'p2', description: 'P2', type: 'utility', tags: [] },
      'P2.',
    );
    await workshop.approveSkill(p2.id);

    const approved = await workshop.getApprovedProposals();
    const pending = await workshop.getPendingProposals();
    expect(approved).toHaveLength(1);
    expect(pending).toHaveLength(1);
  });

  it('persists proposals to disk across workshops', async () => {
    const proposal = await workshop.proposeSkill(
      { name: 'persist_test', description: 'Persist test', type: 'research', tags: ['persist'] },
      'Persist me.',
    );
    await workshop.approveSkill(proposal.id);

    // Create a new workshop instance pointing to the same directory
    const workshop2 = new SkillWorkshop(tmpDir);
    const proposals = await workshop2.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.metadata.name).toBe('persist_test');
    expect(proposals[0]!.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Precedence Ordering
// ---------------------------------------------------------------------------

describe('Precedence ordering', () => {
  it('PRECEDENCE_ORDER has correct numeric values', () => {
    expect(PRECEDENCE_ORDER.workspace).toBe(0);
    expect(PRECEDENCE_ORDER.project).toBe(1);
    expect(PRECEDENCE_ORDER.personal).toBe(2);
    expect(PRECEDENCE_ORDER.bundled).toBe(3);
  });

  it('lower number = higher priority', () => {
    expect(PRECEDENCE_ORDER.workspace).toBeLessThan(PRECEDENCE_ORDER.project);
    expect(PRECEDENCE_ORDER.project).toBeLessThan(PRECEDENCE_ORDER.personal);
    expect(PRECEDENCE_ORDER.personal).toBeLessThan(PRECEDENCE_ORDER.bundled);
  });
});

// ---------------------------------------------------------------------------
// Integration: Full pipeline (loader -> gates -> injector)
// ---------------------------------------------------------------------------

describe('Skills integration pipeline', () => {
  let tmpDir: string;
  let skillsDir: string;
  let loader: SkillLoader;
  let gates: SkillGates;
  let injector: SkillInjector;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    loader = new SkillLoader();
    gates = new SkillGates();
    injector = new SkillInjector();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads, gates, and injects skills end-to-end', async () => {
    // A skill with no requirements should pass gates
    await writeSkillFile(
      skillsDir,
      'simple.skill.md',
      { name: 'simple_skill', description: 'Simple skill', type: 'utility', tags: ['simple'] },
      'Do something simple.',
    );

    // A skill with a missing binary should fail gates
    await writeSkillFile(
      skillsDir,
      'gated.skill.md',
      {
        name: 'gated_skill',
        description: 'Gated skill',
        type: 'analysis',
        tags: ['gated'],
        requires: { bins: ['nonexistent_binary_xyz999'] },
      },
      'Do something gated.',
    );

    await loader.loadFromDirectory(skillsDir, 0);

    const enabled = loader.getEnabledSkills(gates);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.metadata.name).toBe('simple_skill');

    const xml = injector.buildSkillContext(enabled);
    expect(xml).toContain('simple_skill');
    expect(xml).not.toContain('gated_skill');
  });
});
