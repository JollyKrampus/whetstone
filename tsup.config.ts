import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['node:sqlite'],
  // node:sqlite has no unprefixed alias, so keep every node: prefix.
  removeNodeProtocol: false,
});
