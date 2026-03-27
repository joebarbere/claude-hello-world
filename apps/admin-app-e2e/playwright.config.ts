import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// For EKS pods, set BASE_URL to the Traefik proxy path for admin-app
// (e.g. https://<eks-node>:8443/admin-app/).
// When BASE_URL is set, no local dev server is started.
const baseURL = process.env['BASE_URL'] || 'https://localhost:8443/admin-app/';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  use: {
    baseURL,
    /* Ignore self-signed certificate errors for the local Traefik SSL cert */
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  /* In CI: emit GitHub annotations + HTML report + JUnit XML for test-reporter */
  reporter: process.env['CI']
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'playwright-report/junit.xml' }],
      ]
    : undefined,
  /* Only start the local dev server when BASE_URL is not explicitly set */
  ...(process.env['BASE_URL']
    ? {}
    : {
        webServer: {
          command: 'npx nx run admin-app:serve',
          url: 'http://localhost:4203',
          reuseExistingServer: true,
          cwd: workspaceRoot,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
