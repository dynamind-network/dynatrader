import fs from 'fs';
import path from 'path';

function readJsonConfig(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveWorkspaceConfigPath(): string {
  return path.join(
    path.resolve(process.env.DYNAMIND_WORKSPACE_DIR || process.cwd()),
    '.dynamind',
    'config.json'
  );
}

export function resolveSubagentMaxTurns(): number {
  const parsed = readJsonConfig(resolveWorkspaceConfigPath());
  const terminal = parsed.terminal as Record<string, unknown> | undefined;
  const value = terminal?.maxTurns;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return 12;
}

