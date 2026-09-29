import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DynatraderLaunchSpec {
  command: string;
  args: string[];
  source: 'env' | 'local-mjs' | 'local-dist' | 'repo-mjs' | 'repo-dist' | 'binary';
  entryPath?: string;
}

export interface DynatraderLaunchOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  /**
   * Directory containing this Terminal module. Supplying it is primarily useful
   * for tests; by default it anchors discovery to the installed Terminal.
   */
  moduleDir?: string;
  /** Bypass a configured external runtime and launch the local standalone agent. */
  noDaemon?: boolean;
}

function walkUp(startDir: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(startDir);

  while (!roots.includes(current)) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function makeNodeLaunchSpec(
  entryPath: string,
  source: DynatraderLaunchSpec['source']
): DynatraderLaunchSpec {
  return {
    command: process.execPath,
    args: [entryPath, '--stdio'],
    source,
    entryPath,
  };
}

export function resolveDynatraderLaunchSpec(
  options: DynatraderLaunchOptions = {}
): DynatraderLaunchSpec {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const moduleDir = options.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const workspaceDir = env.DYNAMIND_WORKSPACE_DIR?.trim();
  const initCwd = env.INIT_CWD?.trim();

  const configuredEntry = env.DYNATRADER_ENTRY?.trim();
  if (!options.noDaemon && env.DYNATRADER_NO_DAEMON !== 'true' && configuredEntry) {
    const entryPath = path.isAbsolute(configuredEntry)
      ? configuredEntry
      : path.resolve(cwd, configuredEntry);
    if (exists(entryPath)) {
      return makeNodeLaunchSpec(entryPath, 'env');
    }
  }

  // The Terminal normally runs from the user's project directory, which is not
  // necessarily inside the DynaMind repository. Search both the process cwd
  // and this module's installation path so local development remains
  // zero-config while installed binaries can still use DYNATRADER_ENTRY.
  const roots = [
    ...new Set([
      ...walkUp(cwd),
      ...(workspaceDir ? walkUp(workspaceDir) : []),
      ...(initCwd ? walkUp(initCwd) : []),
      ...walkUp(moduleDir),
    ]),
  ];
  for (const root of roots) {
    const repoMjs = path.join(root, 'packages', 'dynatrader', 'dynatrader.mjs');
    if (exists(repoMjs)) {
      return makeNodeLaunchSpec(repoMjs, 'repo-mjs');
    }

    const repoDist = path.join(root, 'packages', 'dynatrader', 'dist', 'entry', 'stdio.js');
    if (exists(repoDist)) {
      return makeNodeLaunchSpec(repoDist, 'repo-dist');
    }

    const localMjs = path.join(root, 'dynatrader.mjs');
    if (exists(localMjs)) {
      return makeNodeLaunchSpec(localMjs, 'local-mjs');
    }

    const localDist = path.join(root, 'dist', 'entry', 'stdio.js');
    if (exists(localDist)) {
      return makeNodeLaunchSpec(localDist, 'local-dist');
    }
  }

  return {
    command: 'dynatrader',
    args: ['--stdio'],
    source: 'binary',
  };
}
