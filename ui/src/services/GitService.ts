import type { SimpleGit, StatusResult } from 'simple-git';
import { simpleGit } from 'simple-git';

export interface GitStatus {
  branch: string | null;
  modified: number;
  staged: number;
  untracked: number;
  isDirty: boolean;
}

let cachedGit: SimpleGit | null = null;

function getGit(cwd: string): SimpleGit {
  if (!cachedGit) {
    cachedGit = simpleGit(cwd);
  }
  return cachedGit;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const git = getGit(cwd);
    await git.revparse(['--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const git = getGit(cwd);
    const branch = await git.branch();
    return branch.current || null;
  } catch {
    return null;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const git = getGit(cwd);
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return null;

    const [branch, status] = await Promise.all([getGitBranch(cwd), git.status()]);

    const stagedCount = status.staged.length + status.created.length + status.renamed.length;

    return {
      branch,
      modified: status.modified.length,
      staged: stagedCount,
      untracked: status.not_added.length,
      isDirty: status.modified.length > 0 || stagedCount > 0 || status.not_added.length > 0,
    };
  } catch {
    return null;
  }
}

export function formatGitStatus(status: GitStatus | null): string | null {
  if (!status || !status.branch) return null;

  let indicator = status.branch;
  if (status.modified > 0) indicator += '*';
  if (status.staged > 0) indicator += '+';
  if (status.untracked > 0) indicator += '~';

  return indicator;
}
