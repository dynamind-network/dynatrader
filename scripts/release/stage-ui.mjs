import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(repoRoot, 'ui', 'dist');
const target = join(repoRoot, 'dist', 'ui');

try {
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`UI build output is not a directory: ${source}`);
  }
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    throw new Error(`UI build output not found: ${source}. Run the UI build first.`);
  }
  throw error;
}

await mkdir(dirname(target), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Staged UI build: ${source} -> ${target}`);
