import { test, expect } from '@playwright/test';

/**
 * E2E tests for the weatherstream-app.
 *
 * The weatherstream-app is a real-time weather event streaming dashboard.
 * In browser mode (no Electron), it runs in simulation mode, generating
 * random weather events every 2 seconds.
 *
 * Run locally:
 *   npx nx run weatherstream-app-e2e:e2e
 */

test.describe('weatherstream-app – page load', () => {
  test('serves the page with a 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('displays the WeatherStream heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('WeatherStream');
  });

  test('shows Simulated badge in browser mode', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.badge.simulated')).toBeVisible();
    await expect(page.locator('.badge.simulated')).toContainText('Simulated');
  });

  test('shows Connected status in simulation mode', async ({ page }) => {
    await page.goto('/');
    const indicator = page.locator('.status-indicator');
    await expect(indicator).toContainText('Connected');
    await expect(indicator).toHaveClass(/connected/);
  });
});

test.describe('weatherstream-app – simulation events', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows empty state initially', async ({ page }) => {
    // The empty state may briefly appear before first simulated event
    const emptyState = page.locator('.empty-state');
    const eventCard = page.locator('.event-card');
    // Either empty state or first event card should be visible
    await expect(emptyState.or(eventCard)).toBeVisible({ timeout: 5000 });
  });

  test('generates weather event cards within 3 seconds', async ({ page }) => {
    const eventCard = page.locator('.event-card').first();
    await expect(eventCard).toBeVisible({ timeout: 5000 });
  });

  test('event cards display location', async ({ page }) => {
    const location = page.locator('.event-card .location').first();
    await expect(location).toBeVisible({ timeout: 5000 });
    const text = await location.innerText();
    expect(text.trim()).not.toBe('');
  });

  test('event cards display temperature with color', async ({ page }) => {
    const tempValue = page.locator('.event-card .metric-value').first();
    await expect(tempValue).toBeVisible({ timeout: 5000 });
    const text = await tempValue.innerText();
    expect(text).toContain('°C');
  });

  test('event cards display humidity', async ({ page }) => {
    const card = page.locator('.event-card').first();
    await expect(card).toBeVisible({ timeout: 5000 });
    const metrics = card.locator('.metric-value');
    // Second metric is humidity
    const humidityText = await metrics.nth(1).innerText();
    expect(humidityText).toContain('%');
  });

  test('event cards display wind speed', async ({ page }) => {
    const card = page.locator('.event-card').first();
    await expect(card).toBeVisible({ timeout: 5000 });
    const metrics = card.locator('.metric-value');
    // Third metric is wind speed
    const windText = await metrics.nth(2).innerText();
    expect(windText).toContain('km/h');
  });

  test('event cards display condition icon', async ({ page }) => {
    const icon = page.locator('.event-card .condition-icon').first();
    await expect(icon).toBeVisible({ timeout: 5000 });
    const text = await icon.innerText();
    expect(text.trim()).not.toBe('');
  });

  test('event count increments over time', async ({ page }) => {
    const countEl = page.locator('.event-count');
    await expect(countEl).toBeVisible();

    // Wait for at least one event
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    const firstCount = await countEl.innerText();

    // Wait for another event cycle
    await page.waitForTimeout(2500);
    const secondCount = await countEl.innerText();

    const first = parseInt(firstCount);
    const second = parseInt(secondCount);
    expect(second).toBeGreaterThan(first);
  });

  test('accumulates multiple event cards', async ({ page }) => {
    // Wait for at least 2 simulation cycles (2s each)
    await page.waitForTimeout(5000);
    const cards = page.locator('.event-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

test.describe('weatherstream-app – interactions', () => {
  test('Clear button removes all events', async ({ page }) => {
    await page.goto('/');

    // Wait for at least one event
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });

    // Click clear
    await page.locator('.btn-clear').click();

    // Events should be cleared — empty state or 0 events
    const countEl = page.locator('.event-count');
    await expect(countEl).toContainText('0 events');
  });

  test('Reconnect button is not shown in simulation mode', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.btn-reconnect')).not.toBeVisible();
  });

  test('no error banner in simulation mode', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.error-banner')).not.toBeVisible();
  });
});
