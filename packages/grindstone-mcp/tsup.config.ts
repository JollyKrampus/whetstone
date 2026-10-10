import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // The MCP server (bin). Unchanged.
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',

    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    external: ['node:sqlite'],
    // node:sqlite has no unprefixed alias, so keep every node: prefix.
    removeNodeProtocol: false,
  },
  {
    // Browser-safe library entry: `import { ... } from 'grindstone-mcp/core'`.
    entry: { core: 'src/core/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    sourcemap: true,
    // tsup's dts worker sets baseUrl, which TypeScript 6 deprecates.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    // Let the consumer's bundler resolve zod (a normal dependency).
    external: ['zod'],
  },
]);
