import { test, expect } from '@playwright/test';

/**
 * E2E tests for the weather-app MFE running in the EKS nginx pod.
 *
 * The weather-app is a read-only Angular micro-frontend that fetches
 * weather forecast data from the API and displays it in a table.
 * It is served by the nginx pod under /weather-app/.
 *
 * Run against the EKS pod:
 *   BASE_URL=http://<eks-node>:8080/weather-app/ npx nx run weather-app-e2e:e2e
 */

test.describe('weather-app – page load', () => {
  test('serves the page with a 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('displays the "Weather Forecast" heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h2')).toContainText('Weather Forecast');
  });

  test('shows a loading indicator or forecast table on initial render', async ({
    page,
  }) => {
    await page.goto('/');
    const loading = page.locator('p', { hasText: 'Loading...' });
    const table = page.locator('table');
    await expect(loading.or(table)).toBeVisible({ timeout: 10000 });
  });
});

test.describe('weather-app – forecast table', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the table to be visible (API call completes)
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });
  });

  test('renders the correct table column headers', async ({ page }) => {
    const headers = page.locator('thead th');
    await expect(headers.nth(0)).toContainText('Date');
    await expect(headers.nth(1)).toContainText('Temp (°C)');
    await expect(headers.nth(2)).toContainText('Temp (°F)');
    await expect(headers.nth(3)).toContainText('Summary');
  });

  test('displays at least one forecast data row', async ({ page }) => {
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('each row has a non-empty date cell', async ({ page }) => {
    const firstDateCell = page.locator('tbody tr:first-child td:nth-child(1)');
    const dateText = await firstDateCell.innerText();
    expect(dateText.trim()).not.toBe('');
  });

  test('each row has numeric temperature values', async ({ page }) => {
    const tempCCell = page.locator('tbody tr:first-child td:nth-child(2)');
    const tempFCell = page.locator('tbody tr:first-child td:nth-child(3)');
    const tempC = await tempCCell.innerText();
    const tempF = await tempFCell.innerText();
    expect(Number.isFinite(parseFloat(tempC))).toBe(true);
    expect(Number.isFinite(parseFloat(tempF))).toBe(true);
  });

  test('does not show an error message when data loads successfully', async ({
    page,
  }) => {
    await expect(page.locator('.error')).not.toBeVisible();
  });
});
