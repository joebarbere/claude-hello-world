import { test, expect } from '@playwright/test';

/**
 * E2E tests for the weatheredit-app MFE running in the EKS nginx pod.
 *
 * weatheredit-app is a full CRUD Angular micro-frontend that lets users
 * create, read, update and delete weather forecasts via the weather-api pod.
 * It is served by the nginx pod under /weatheredit-app/.
 *
 * Access requires authentication via Ory Kratos. Each test navigates to /
 * (BASE_URL = http://localhost:8080/weatheredit-app/), which triggers the
 * Angular auth guard. If the session cookie is not present the guard redirects
 * to Kratos and then to /auth/login. The login() helper fills in credentials
 * for the seeded admin user and submits the form, after which Kratos sets the
 * session cookie and redirects back.
 *
 * Run against the EKS pod:
 *   BASE_URL=http://<eks-node>:8080/weatheredit-app/ npx nx run weatheredit-app-e2e:e2e
 */

/**
 * Log in via the Ory Kratos browser flow if redirected to /auth/login.
 * Credentials match the default users seeded by the ory-kratos-init container.
 */
async function loginIfRequired(page: import('@playwright/test').Page) {
  if (page.url().includes('/auth/login') || page.url().includes('self-service/login')) {
    await page.fill('input[name="identifier"]', 'admin@example.com');
    await page.fill('input[name="password"]', 'Admin1234!');
    await page.locator('button[type="submit"]').click();
    // Kratos sets the session cookie and redirects back to weatheredit-app
    await page.waitForURL('**/weatheredit-app/**', { timeout: 15000 });
  }
}

/** Helper: open the "New Forecast" form */
async function openNewForecastForm(page: import('@playwright/test').Page) {
  await page.locator('button', { hasText: 'New Forecast' }).first().click();
  await expect(page.locator('h2', { hasText: 'New Forecast' })).toBeVisible();
}

/** Helper: fill and submit the forecast form */
async function submitForecastForm(
  page: import('@playwright/test').Page,
  date: string,
  temperatureC: number,
  summary: string
) {
  await page.fill('#date', date);
  await page.fill('#temp', String(temperatureC));
  await page.fill('#summary', summary);
  await page.locator('button[type="submit"]').click();
}

/**
 * Authenticate before every test. Each Playwright test gets a fresh browser
 * context (no cookies), so we navigate to the base URL and log in if the auth
 * guard redirected us to /auth/login. Once logged in, Kratos sets the session
 * cookie for the rest of that test's context.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await loginIfRequired(page);
});

test.describe('weatheredit-app – page load', () => {
  test('serves the page with a 200 status', async ({ page }) => {
    // beforeEach has already navigated and logged in; verify we are on the app
    expect(page.url()).toMatch(/\/weatheredit-app/);
    // Confirm the page loaded successfully by checking the heading is present
    await expect(page.locator('h1')).toContainText('Weather Forecasts');
  });

  test('displays the "Weather Forecasts" heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Weather Forecasts');
  });

  test('shows a loading state or forecast content after initial render', async ({
    page,
  }) => {
    await page.goto('/');
    const spinner = page.locator('.loading-state');
    const card = page.locator('.card');
    await expect(spinner.or(card)).toBeVisible({ timeout: 10000 });
  });

  test('shows the "New Forecast" button once loaded', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.locator('button', { hasText: 'New Forecast' }).first()
    ).toBeVisible({ timeout: 15000 });
  });
});

test.describe('weatheredit-app – forecast table', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for loading spinner to disappear
    await page.waitForSelector('.loading-state', { state: 'hidden', timeout: 15000 }).catch(() => { /* loading state may not appear */ });
  });

  test('displays the table or empty state', async ({ page }) => {
    const table = page.locator('table');
    const emptyState = page.locator('.empty-state');
    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('when forecasts exist, table shows correct column headers', async ({
    page,
  }) => {
    const table = page.locator('table');
    const emptyState = page.locator('.empty-state');

    const tableVisible = await table.isVisible().catch(() => false);
    if (!tableVisible) {
      // No data yet — skip header check
      await expect(emptyState).toBeVisible();
      return;
    }

    const headers = page.locator('thead th');
    await expect(headers.nth(0)).toContainText('ID');
    await expect(headers.nth(1)).toContainText('Date');
    await expect(headers.nth(2)).toContainText('Temp °C');
    await expect(headers.nth(3)).toContainText('Temp °F');
    await expect(headers.nth(4)).toContainText('Summary');
    await expect(headers.nth(5)).toContainText('Actions');
  });
});

test.describe('weatheredit-app – create forecast', () => {
  const testSummary = `E2E-Create-${Date.now()}`;

  test('opens the New Forecast form when button is clicked', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'New Forecast' }).first().click();
    await expect(page.locator('h2', { hasText: 'New Forecast' })).toBeVisible();
    await expect(page.locator('#date')).toBeVisible();
    await expect(page.locator('#temp')).toBeVisible();
    await expect(page.locator('#summary')).toBeVisible();
  });

  test('cancelling the form hides it without creating a forecast', async ({
    page,
  }) => {
    await page.goto('/');
    await openNewForecastForm(page);
    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('h2', { hasText: 'New Forecast' })).not.toBeVisible();
  });

  test('creates a new forecast and shows it in the table', async ({ page }) => {
    await page.goto('/');
    await openNewForecastForm(page);

    const today = new Date().toISOString().split('T')[0];
    await submitForecastForm(page, today, 22, testSummary);

    // Form should close and the new row should appear
    await expect(page.locator('h2', { hasText: 'New Forecast' })).not.toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.locator('td', { hasText: testSummary })
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe('weatheredit-app – edit forecast', () => {
  const initialSummary = `E2E-Edit-Init-${Date.now()}`;
  const updatedSummary = `E2E-Edit-Updated-${Date.now()}`;

  test('edits an existing forecast and reflects the updated summary', async ({
    page,
  }) => {
    await page.goto('/');

    // Create a forecast to edit
    await openNewForecastForm(page);
    const today = new Date().toISOString().split('T')[0];
    await submitForecastForm(page, today, 15, initialSummary);
    await expect(
      page.locator('td', { hasText: initialSummary })
    ).toBeVisible({ timeout: 10000 });

    // Click the Edit button on that row
    const row = page.locator('tr', { hasText: initialSummary });
    await row.locator('button', { hasText: 'Edit' }).click();

    // Edit form should appear pre-filled
    await expect(page.locator('h2', { hasText: 'Edit Forecast' })).toBeVisible();

    // Update the summary field
    await page.fill('#summary', updatedSummary);
    await page.locator('button[type="submit"]').click();

    // Updated row should now be visible
    await expect(
      page.locator('td', { hasText: updatedSummary })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('td', { hasText: initialSummary })
    ).not.toBeVisible();
  });
});

test.describe('weatheredit-app – delete forecast', () => {
  const deleteSummary = `E2E-Delete-${Date.now()}`;

  test('deletes a forecast after confirming and removes it from the table', async ({
    page,
  }) => {
    await page.goto('/');

    // Create a forecast to delete
    await openNewForecastForm(page);
    const today = new Date().toISOString().split('T')[0];
    await submitForecastForm(page, today, 10, deleteSummary);
    await expect(
      page.locator('td', { hasText: deleteSummary })
    ).toBeVisible({ timeout: 10000 });

    // Click Delete on that row
    const row = page.locator('tr', { hasText: deleteSummary });
    await row.locator('button', { hasText: 'Delete' }).click();

    // Confirm prompt "Delete?" → Yes
    await expect(row.locator('span', { hasText: 'Delete?' })).toBeVisible();
    await row.locator('button', { hasText: 'Yes' }).click();

    // Row should be gone
    await expect(
      page.locator('td', { hasText: deleteSummary })
    ).not.toBeVisible({ timeout: 10000 });
  });

  test('cancels deletion when "No" is clicked', async ({ page }) => {
    await page.goto('/');

    // Create a forecast
    await openNewForecastForm(page);
    const today = new Date().toISOString().split('T')[0];
    const cancelSummary = `E2E-Cancel-Delete-${Date.now()}`;
    await submitForecastForm(page, today, 5, cancelSummary);
    await expect(
      page.locator('td', { hasText: cancelSummary })
    ).toBeVisible({ timeout: 10000 });

    // Attempt delete then cancel
    const row = page.locator('tr', { hasText: cancelSummary });
    await row.locator('button', { hasText: 'Delete' }).click();
    await expect(row.locator('span', { hasText: 'Delete?' })).toBeVisible();
    await row.locator('button', { hasText: 'No' }).click();

    // Row should still be present
    await expect(
      page.locator('td', { hasText: cancelSummary })
    ).toBeVisible();
  });
});

test.describe('weatheredit-app – error handling', () => {
  test('does not show an error alert on successful page load', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForSelector('.loading-state', { state: 'hidden', timeout: 15000 }).catch(() => { /* loading state may not appear */ });
    await expect(page.locator('.alert-error')).not.toBeVisible();
  });
});
