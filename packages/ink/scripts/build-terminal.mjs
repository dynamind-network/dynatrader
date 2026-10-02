import { build } from 'esbuild';

// The TUI imports Ink's renderer at startup. Bundle Ink's internal modules
// into one ESM entry while keeping React and native npm dependencies external.
await build({
  entryPoints: ['src/terminal.ts'],
  bundle: true,
  packages: 'external',
  // Keep Ink's optional React DevTools path truly lazy; its peer package is
  // intentionally absent from normal production installs.
  external: ['./devtools.js'],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/terminal.js',
  logLevel: 'silent',
});
