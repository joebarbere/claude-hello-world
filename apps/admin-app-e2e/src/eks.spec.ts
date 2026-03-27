import { test, expect } from '@playwright/test';

/**
 * E2E tests for the admin-app MFE running behind the Traefik reverse proxy.
 *
 * admin-app is an admin-only Angular micro-frontend that displays useful links
 * for administrators (Swagger, Kratos admin, Grafana, Traefik dashboard).
 * It is served by the nginx pod under /admin-app/.
 *
 * Access requires authentication via Ory Kratos with the "admin" role.
 * Users with only "weather_admin" role should be denied access.
 *
 * Run against the EKS pod:
 *   BASE_URL=https://<eks-node>:8443/admin-app/ npx nx run admin-app-e2e:e2e
 */

/**
 * Log in via the Ory Kratos browser flow if redirected to /auth/login.
 * Credentials match the default admin user seeded by the ory-kratos-init container.
 */
async function loginAsAdmin(page: import('@playwright/test').Page) {
  if (
    page.url().includes('/auth/login') ||
    page.url().includes('self-service/login')
  ) {
    await page.fill('input[name="identifier"]', 'admin@example.com');
    await page.fill('input[name="password"]', 'Admin1234!');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/admin-app/**', { timeout: 15000 });
  }
}

test.describe('admin-app – access control', () => {
  test('unauthenticated users are redirected to the Ory login page', async ({
    page,
  }) => {
    await page.goto('/');
    // Auth guard redirects to Kratos browser flow → /auth/login
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });
    await expect(page.locator('input[name="identifier"]')).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe('admin-app – authenticated admin', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loginAsAdmin(page);
  });

  test('displays the Admin Dashboard heading', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Admin Dashboard');
  });

  test('shows the Weather API Swagger link', async ({ page }) => {
    await expect(
      page.locator('.link-name', { hasText: 'Weather API Swagger' })
    ).toBeVisible();
  });

  test('shows the Ory Kratos Admin link', async ({ page }) => {
    await expect(
      page.locator('.link-name', { hasText: 'Ory Kratos Admin' })
    ).toBeVisible();
  });

  test('shows the Grafana Dashboard link', async ({ page }) => {
    await expect(
      page.locator('.link-name', { hasText: 'Grafana Dashboard' })
    ).toBeVisible();
  });

  test('shows the Traefik Dashboard link', async ({ page }) => {
    await expect(
      page.locator('.link-name', { hasText: 'Traefik Dashboard' })
    ).toBeVisible();
  });

  test('admin link cards open in a new tab', async ({ page }) => {
    const cards = page.locator('.link-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toHaveAttribute('target', '_blank');
    }
  });

  test('displays correct category sections', async ({ page }) => {
    await expect(
      page.locator('.section-title', { hasText: 'API' })
    ).toBeVisible();
    await expect(
      page.locator('.section-title', { hasText: 'Identity' })
    ).toBeVisible();
    await expect(
      page.locator('.section-title', { hasText: 'Observability' })
    ).toBeVisible();
    await expect(
      page.locator('.section-title', { hasText: 'Infrastructure' })
    ).toBeVisible();
  });
});
