import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface Checkpoint {
  id: string;
  sessionId: string;
  label: string;
  timestamp: number;
  changedFiles: string[];
  diffHash: string;
  gitRef?: string;
}

export interface CheckpointDiff {
  file: string;
  status: 'added' | 'modified' | 'deleted';
  patch?: string;
}

const CHECKPOINTS_DIR = '.dynamind/checkpoints';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getCheckpointsDir(cwd: string, sessionId: string): string {
  const dir = path.join(cwd, CHECKPOINTS_DIR, sessionId);
  ensureDir(dir);
  return dir;
}

function readJsonl(filePath: string): Checkpoint[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Checkpoint);
}

function appendJsonl(filePath: string, data: Checkpoint): void {
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

function generateId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function execGit(args: string[], cwd: string): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function isGitRepo(cwd: string): boolean {
  return execGit(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

function getChangedFiles(cwd: string): string[] {
  const status = execGit(['status', '--porcelain'], cwd);
  if (!status) return [];
  return status
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.substring(3).trim());
}

function computeDiffHash(cwd: string): string {
  const diff = execGit(['diff', '--stat'], cwd);
  if (!diff) return 'clean';
  let hash = 0;
  for (let i = 0; i < diff.length; i++) {
    hash = (hash * 31 + diff.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export class CheckpointManager {
  private cwd: string;
  private sessionId: string;

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
  }

  createCheckpoint(label: string): Checkpoint | null {
    if (!isGitRepo(this.cwd)) return null;

    const changedFiles = getChangedFiles(this.cwd);
    const diffHash = computeDiffHash(this.cwd);
    const gitRef = execGit(['rev-parse', 'HEAD'], this.cwd);

    const checkpoint: Checkpoint = {
      id: generateId(),
      sessionId: this.sessionId,
      label,
      timestamp: Date.now(),
      changedFiles,
      diffHash,
      gitRef: gitRef || undefined,
    };

    const checkpointsFile = path.join(
      getCheckpointsDir(this.cwd, this.sessionId),
      'checkpoints.jsonl'
    );
    appendJsonl(checkpointsFile, checkpoint);

    return checkpoint;
  }

  revertToCheckpoint(checkpointId: string): { success: boolean; message: string } {
    if (!isGitRepo(this.cwd)) {
      return { success: false, message: 'Not a git repository' };
    }

    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      return { success: false, message: `Checkpoint ${checkpointId} not found` };
    }

    if (checkpoint.gitRef) {
      const result = execGit(['checkout', checkpoint.gitRef, '--', '.'], this.cwd);
      if (result === '' || !result.includes('error')) {
        return { success: true, message: `Reverted to checkpoint: ${checkpoint.label}` };
      }
      return { success: false, message: `Git checkout failed: ${result}` };
    }

    return { success: false, message: 'No git ref available for this checkpoint' };
  }

  diffSinceCheckpoint(checkpointId: string): CheckpointDiff[] {
    if (!isGitRepo(this.cwd)) return [];

    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint || !checkpoint.gitRef) return [];

    const diffOutput = execGit(['diff', '--name-status', checkpoint.gitRef], this.cwd);
    if (!diffOutput) return [];

    return diffOutput
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [status, ...fileParts] = line.split('\t');
        const file = fileParts.join('\t');
        return {
          file,
          status:
            status === 'A'
              ? ('added' as const)
              : status === 'D'
                ? ('deleted' as const)
                : ('modified' as const),
        };
      });
  }

  listCheckpoints(): Checkpoint[] {
    const checkpointsFile = path.join(
      getCheckpointsDir(this.cwd, this.sessionId),
      'checkpoints.jsonl'
    );
    return readJsonl(checkpointsFile);
  }

  private getCheckpoint(id: string): Checkpoint | undefined {
    return this.listCheckpoints().find((cp) => cp.id === id);
  }
}

let globalManager: CheckpointManager | null = null;

export function getCheckpointManager(cwd: string, sessionId: string): CheckpointManager {
  if (!globalManager || globalManager['sessionId'] !== sessionId) {
    globalManager = new CheckpointManager(cwd, sessionId);
  }
  return globalManager;
}

export function autoCheckpoint(
  cwd: string,
  sessionId: string,
  label: string
): Checkpoint | null {
  const manager = getCheckpointManager(cwd, sessionId);
  return manager.createCheckpoint(label);
}

