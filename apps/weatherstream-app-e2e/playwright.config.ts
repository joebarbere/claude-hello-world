import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// WeatherStream app runs on port 4203 in dev mode.
// When BASE_URL is set, no local dev server is started.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4203';

export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  reporter: process.env['CI']
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'playwright-report/junit.xml' }],
      ]
    : undefined,
  ...(process.env['BASE_URL']
    ? {}
    : {
        webServer: {
          command: 'npx nx serve weatherstream-app',
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
