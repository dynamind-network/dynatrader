import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(packageRoot, 'dist');
if (distPath !== join(packageRoot, 'dist')) {
  throw new Error(`Refusing to clean generated files outside the UI package: ${distPath}`);
}

await rm(distPath, { recursive: true, force: true });
