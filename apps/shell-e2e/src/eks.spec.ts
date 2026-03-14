import { test, expect } from '@playwright/test';

/**
 * E2E tests for the shell (host) application running behind the Traefik reverse proxy.
 *
 * Traefik handles SSL termination and proxying:
 *   /               → nginx (static files) → shell Angular host app
 *   /weather-app/   → nginx (static files) → weather-app MFE remote
 *   /weatheredit-app/ → nginx (static files) → weatheredit-app MFE remote
 *   /admin-app/     → nginx (static files) → admin-app MFE remote
 *   /weather        → proxied to weather-api pod
 *
 * Run against the EKS pod:
 *   BASE_URL=https://<eks-node>:8443 npx nx run shell-e2e:e2e
 */

test.describe('Shell host – home page', () => {
  test('loads and displays the welcome heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#welcome h1')).toContainText('Welcome shell');
  });

  test('shows the hero "You\'re up and running" banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#hero')).toBeVisible();
    await expect(page.locator('#hero .text-container h2 span')).toContainText(
      "You're up and running"
    );
  });

  test('serves static assets with 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });
});

test.describe('Shell host – MFE navigation', () => {
  test('navigates to weather-app and displays forecast heading', async ({
    page,
  }) => {
    await page.goto('/weather-app');
    // MFE remote entry renders <h2>Weather Forecast</h2>
    await expect(page.locator('h2')).toContainText('Weather Forecast', {
      timeout: 15000,
    });
  });

  test('navigates to weatheredit-app and is redirected to the Ory login page', async ({
    page,
  }) => {
    await page.goto('/weatheredit-app');
    // Auth guard redirects to Kratos browser flow, which redirects to /auth/login?flow=<id>
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });
    // Angular login component renders the Kratos form
    await expect(page.locator('input[name="identifier"]')).toBeVisible({
      timeout: 10000,
    });
  });

  test('weather-app route loads the forecast table or loading state', async ({
    page,
  }) => {
    await page.goto('/weather-app');
    const loading = page.locator('p', { hasText: 'Loading...' });
    const table = page.locator('table');
    await expect(loading.or(table)).toBeVisible({ timeout: 15000 });
  });

  test('weatheredit-app route shows the Ory login form when unauthenticated', async ({
    page,
  }) => {
    await page.goto('/weatheredit-app');
    // Auth guard triggers Kratos browser flow → redirects to /auth/login?flow=<id>
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });
    await expect(page.locator('input[name="password"]')).toBeVisible({
      timeout: 10000,
    });
  });

  test('navigates to admin-app and is redirected to the Ory login page', async ({
    page,
  }) => {
    await page.goto('/admin-app');
    // Admin auth guard redirects to Kratos browser flow → /auth/login?flow=<id>
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });
    await expect(page.locator('input[name="identifier"]')).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe('Shell host – weather API proxy', () => {
  test('proxies /weather to the weather-api pod and returns JSON', async ({
    page,
  }) => {
    const response = await page.request.get('/weather');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
