import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// For EKS pods, set BASE_URL to the Traefik proxy path for weatheredit-app
// (e.g. https://<eks-node>:8443/weatheredit-app/).
// When BASE_URL is set, no local dev server is started.
const baseURL = process.env['BASE_URL'] || 'https://localhost:8443/weatheredit-app/';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Ignore self-signed certificate errors for the local Traefik SSL cert */
    ignoreHTTPSErrors: true,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
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
          command: 'npx nx run weatheredit-app:serve',
          url: 'http://localhost:4202',
          reuseExistingServer: true,
          cwd: workspaceRoot,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
});
