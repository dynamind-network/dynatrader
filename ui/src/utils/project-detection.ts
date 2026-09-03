import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import { parseJson } from './json.js';
import { DYNAMIND_DIR } from './constants.js';

/**
 * Find the DynaMind Terminal project root directory by searching for .dynamind/
 * or package.json with the terminal package name.
 */
export function findProjectRoot(startPath?: string): string | null {
  const startDir = startPath || process.cwd();
  let currentDir = path.resolve(startDir);
  const userHome = path.resolve(homedir());

  // Walk up directory tree looking for .dynamind/ directory.
  while (currentDir !== path.dirname(currentDir)) {
    const dynamindDir = path.join(currentDir, DYNAMIND_DIR);
    if (
      currentDir !== userHome &&
      fs.existsSync(dynamindDir) &&
      fs.statSync(dynamindDir).isDirectory()
    ) {
      return currentDir;
    }

    // Also check for the public package name.
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = parseJson<{ name?: string }>(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (pkg && pkg.name === 'dynamind-terminal') {
          return currentDir;
        }
      } catch {
        // Continue searching
      }
    }

    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Get the project directory for MCP operations
 * Falls back to current directory if project root is not found
 */
export function getProjectDirectory(startPath?: string): string {
  const projectRoot = findProjectRoot(startPath);
  return projectRoot || path.resolve(startPath || process.cwd());
}
