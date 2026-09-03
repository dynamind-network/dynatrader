import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export interface EvolutionBranchRequest {
  skillName: string;
  instructions: string;
  description: string;
  baseBranch?: string;
}

export interface EvolutionBranchResult {
  branch: string;
  skillPath: string;
  commit: string;
}

export interface PrGeneratorConfig {
  repoPath: string;
  skillRoot?: string;
  exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/** Creates an auditable git branch/commit for human review of an evolved skill. */
export class EvolutionPrGenerator {
  private readonly repoPath: string;
  private readonly skillRoot: string;
  private readonly run: NonNullable<PrGeneratorConfig['exec']>;

  constructor(config: PrGeneratorConfig) {
    this.repoPath = config.repoPath;
    this.skillRoot = config.skillRoot ?? 'workspace/skills';
    this.run = config.exec ?? (async (command, args) => {
      const result = await execFile(command, args, { cwd: this.repoPath });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }

  async generate(request: EvolutionBranchRequest): Promise<EvolutionBranchResult> {
    const safeName = slug(request.skillName);
    const branch = `evolution/${safeName}-${Date.now()}`;
    const skillPath = join(this.skillRoot, safeName, 'SKILL.md');
    await this.run('git', ['switch', request.baseBranch ?? 'main']);
    await this.run('git', ['switch', '-c', branch]);
    const absoluteSkillPath = join(this.repoPath, skillPath);
    await mkdir(join(this.repoPath, this.skillRoot, safeName), { recursive: true });
    await writeFile(absoluteSkillPath, renderSkill(request.skillName, request.description, request.instructions), 'utf8');
    await this.run('git', ['add', skillPath]);
    const commitResult = await this.run('git', ['commit', '-m', `evolution: improve ${safeName}`]);
    const commit = (commitResult.stdout.match(/[0-9a-f]{7,40}/i)?.[0]) ?? 'created';
    return { branch, skillPath, commit };
  }
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill'; }
function renderSkill(name: string, description: string, instructions: string): string { return `---\nname: ${slug(name)}\ndescription: ${description.replace(/\n/g, ' ')}\ntype: utility\ntags: [evolved]\n---\n\n# ${name}\n\n${instructions.trim()}\n`; }
