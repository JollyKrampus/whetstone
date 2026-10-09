import { defineConfig } from 'vitest/config';

// Plain Vite resolution already understands `.ts` specifiers and package.json "imports"
// (#core/*, #games/*, #pipeline/*, #vendor/*), so tests resolve modules exactly like Node does.
export default defineConfig({
  test: {
    environment: 'node',
    // Same base as astro.config.mjs, so import.meta.env.BASE_URL and the URL helpers match the site.
    env: { BASE_URL: '/whetstone/' },
    include: ['src/**/*.test.ts', 'pipeline/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'data/**', 'vendor/**'],
    // The stats simulation harness is CPU-bound; give it room on slow CI runners.
    testTimeout: 20_000,
  },
});
