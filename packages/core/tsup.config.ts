import { defineConfig } from 'tsup';
import { copyFileSync } from 'node:fs';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'kernel/index': 'src/kernel/index.ts',
    'providers/runtime': 'src/providers/runtime.ts',
    'hooks/index': 'src/agent/core/event-hooks/index.ts',
  },
  format: 'esm',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  tsconfig: '../../tsconfig.json',
  bundle: true,
  // providers/yaml-loader.ts resolves the bundled provider/model catalog from
  // <dist>/models.default.yaml (import.meta.url points into dist/ in the
  // bundled build). tsup does not copy non-JS assets, so without this step the
  // loader misses the file and the `if (defaultYAML)` guard swallows it -- the
  // published package then reports zero providers and zero models, silently.
  onSuccess: async () => {
    copyFileSync('src/providers/models.default.yaml', 'dist/models.default.yaml');
  },
});