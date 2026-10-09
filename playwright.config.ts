import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium smoke tests against a production build served by `astro preview` (build first:
 * `npm run build`). Locally, PW_CHANNEL=chrome|msedge uses an installed browser instead of the
 * downloaded Chromium, SMOKE_PORT moves the server, and WHETSTONE_OUT_DIR previews a build that
 * was written somewhere other than dist/.
 */
const PORT = Number(process.env.SMOKE_PORT ?? 4321);
const BASE_URL = `http://localhost:${PORT}/whetstone/`;
const channel = process.env.PW_CHANNEL;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    // --ignore-lock keeps astro preview in the foreground even when it detects an agent or another server.
    command: `npx astro preview --port ${PORT} --ignore-lock`,
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
