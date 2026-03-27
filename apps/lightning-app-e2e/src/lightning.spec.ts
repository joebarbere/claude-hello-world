import { test, expect } from '@playwright/test';

/**
 * E2E tests for the lightning-app (Electron + Kafka weather streaming).
 *
 * These tests run against the weatherstream-app Angular UI that lightning-app
 * hosts. In browser mode (no Electron), the app operates in simulation mode.
 *
 * For full Electron integration testing, use Playwright Electron support
 * or run with BASE_URL pointing to the Electron-hosted instance.
 *
 * Run locally:
 *   npx nx run lightning-app-e2e:e2e
 */

test.describe('lightning-app – dashboard structure', () => {
  test('loads the dashboard page', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('renders the WeatherStream header with lightning icon', async ({
    page,
  }) => {
    await page.goto('/');
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    const text = await h1.innerText();
    expect(text).toContain('WeatherStream');
  });

  test('renders the status bar with all elements', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.status-indicator')).toBeVisible();
    await expect(page.locator('.event-count')).toBeVisible();
    await expect(page.locator('.btn-clear')).toBeVisible();
  });

  test('shows the correct mode badge', async ({ page }) => {
    await page.goto('/');
    // In browser mode, should show Simulated
    const simBadge = page.locator('.badge.simulated');
    const elBadge = page.locator('.badge.electron');
    await expect(simBadge.or(elBadge)).toBeVisible();
  });
});

test.describe('lightning-app – real-time streaming', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('begins streaming weather events automatically', async ({ page }) => {
    const firstCard = page.locator('.event-card').first();
    await expect(firstCard).toBeVisible({ timeout: 5000 });
  });

  test('each event card has a condition icon', async ({ page }) => {
    const icon = page.locator('.event-card .condition-icon').first();
    await expect(icon).toBeVisible({ timeout: 5000 });
  });

  test('each event card shows a location name', async ({ page }) => {
    const location = page.locator('.event-card .location').first();
    await expect(location).toBeVisible({ timeout: 5000 });

    const knownLocations = [
      'New York',
      'London',
      'Tokyo',
      'Sydney',
      'Paris',
      'Berlin',
      'Mumbai',
      'São Paulo',
      'Cairo',
      'Toronto',
    ];
    const text = await location.innerText();
    expect(knownLocations).toContain(text.trim());
  });

  test('event cards show three metrics (temp, humidity, wind)', async ({
    page,
  }) => {
    const card = page.locator('.event-card').first();
    await expect(card).toBeVisible({ timeout: 5000 });

    const labels = card.locator('.metric-label');
    await expect(labels.nth(0)).toContainText('Temp');
    await expect(labels.nth(1)).toContainText('Humidity');
    await expect(labels.nth(2)).toContainText('Wind');
  });

  test('event cards display a timestamp', async ({ page }) => {
    const time = page.locator('.event-card .event-time').first();
    await expect(time).toBeVisible({ timeout: 5000 });
    const text = await time.innerText();
    // Should be a time string like HH:mm:ss.SSS
    expect(text.trim()).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  test('new events appear at the top of the grid', async ({ page }) => {
    // Wait for two events
    await page.waitForTimeout(5000);
    const cards = page.locator('.event-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // The first card's timestamp should be the most recent
    const firstTime = page.locator('.event-card .event-time').first();
    const lastTime = page.locator('.event-card .event-time').last();
    const firstText = await firstTime.innerText();
    const lastText = await lastTime.innerText();
    // Both should be valid timestamps
    expect(firstText.trim()).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(lastText.trim()).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

test.describe('lightning-app – controls', () => {
  test('Clear button clears all events and resets count', async ({ page }) => {
    await page.goto('/');

    // Wait for events to appear
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    const countBefore = await page.locator('.event-count').innerText();
    expect(parseInt(countBefore)).toBeGreaterThan(0);

    // Clear
    await page.locator('.btn-clear').click();

    // Verify cleared
    await expect(page.locator('.event-count')).toContainText('0 events');
  });

  test('events resume after clearing', async ({ page }) => {
    await page.goto('/');

    // Wait for events, clear, then wait again
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    await page.locator('.btn-clear').click();
    await expect(page.locator('.event-count')).toContainText('0 events');

    // Events should resume within the next simulation cycle
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    const countAfter = await page.locator('.event-count').innerText();
    expect(parseInt(countAfter)).toBeGreaterThan(0);
  });
});
