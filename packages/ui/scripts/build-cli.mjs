import { access, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Split optional runtime integrations into ESM chunks. Screen components are
// statically imported so every page is ready when the TUI first renders.
const scriptPath = fileURLToPath(import.meta.url);
const distPath = join(dirname(scriptPath), '..', 'dist');
const generatedChunksPath = join(distPath, 'chunks');
if (!generatedChunksPath.startsWith(distPath + sep)) {
  throw new Error(`Refusing to clean generated files outside the UI package: ${generatedChunksPath}`);
}
await rm(generatedChunksPath, { recursive: true, force: true });
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  splitting: true,
  target: 'node22',
  outdir: distPath,
  entryNames: 'cli',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});
await access(join(distPath, 'cli.js'));
