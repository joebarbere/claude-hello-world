/**
 * Captures screenshots of each Angular app using Playwright.
 * Serves each built app on a local HTTP server, mocks API responses,
 * and takes viewport-sized screenshots.
 *
 * Usage: node scripts/take-screenshots.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist', 'apps');
const OUT = path.join(ROOT, 'docs', 'screenshots');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

const MOCK_FORECASTS = [
  { id: 1, date: '2026-03-18', temperatureC: 22, temperatureF: 72, summary: 'Warm' },
  { id: 2, date: '2026-03-19', temperatureC: 15, temperatureF: 59, summary: 'Cool' },
  { id: 3, date: '2026-03-20', temperatureC: -3, temperatureF: 27, summary: 'Freezing' },
  { id: 4, date: '2026-03-21', temperatureC: 30, temperatureF: 86, summary: 'Hot' },
  { id: 5, date: '2026-03-22', temperatureC: 8, temperatureF: 46, summary: 'Chilly' },
];

const MOCK_SESSION = {
  id: 'mock-session',
  active: true,
  identity: {
    id: 'mock-user',
    traits: { email: 'admin@example.com' },
    metadata_public: { role: 'admin' },
  },
};

/**
 * Serves static files from `dir` under the URL prefix `basePath`.
 * e.g. basePath="/weather-app/" means /weather-app/main.js → dir/main.js
 * Any request not matching a file falls back to dir/index.html.
 */
function serveStatic(dir, port, basePath = '/') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      let reqPath = url.pathname;

      // Strip the basePath prefix to map to file on disk
      if (basePath !== '/' && reqPath.startsWith(basePath)) {
        reqPath = '/' + reqPath.slice(basePath.length);
      }

      let filePath = path.join(dir, reqPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(dir, 'index.html');
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });

    server.listen(port, () => resolve(server));
  });
}

async function setupPageMocks(page, port) {
  // Mock weather API
  await page.route('**/weather', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FORECASTS),
      });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  // Mock Kratos session
  await page.route('**/.ory/kratos/public/sessions/whoami', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SESSION),
    });
  });

  // Mock MFE remote entries (they fail in standalone mode)
  await page.route('**/remoteEntry.mjs', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'export default {};',
    });
  });

  // Mock remote mf-manifest.json requests (not from our own server)
  await page.route('**/mf-manifest.json', (route) => {
    const url = route.request().url();
    if (!url.includes(`:${port}/`)) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    } else {
      route.continue();
    }
  });

  // Mock Kratos admin API for admin-app
  await page.route('**/.ory/kratos/admin/identities*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '1',
          traits: { email: 'admin@example.com' },
          metadata_public: { role: 'admin' },
          state: 'active',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: '2',
          traits: { email: 'weatheradmin@example.com' },
          metadata_public: { role: 'weather_admin' },
          state: 'active',
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
    });
  });
}

async function takeScreenshot(browser, url, outputPath, port) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await setupPageMocks(page, port);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000); // Let Angular fully render

  await page.screenshot({ path: outputPath, type: 'png' });
  console.log(`  Screenshot saved: ${outputPath}`);
  await context.close();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
  });
  const servers = [];

  try {
    // --- Shell (Home page) — base href="/" ---
    console.log('Capturing shell (home page)...');
    const shellServer = await serveStatic(path.join(DIST, 'shell'), 9100, '/');
    servers.push(shellServer);
    await takeScreenshot(browser, 'http://localhost:9100/', path.join(OUT, 'shell-home.png'), 9100);

    // --- Weather App — base href="/weather-app/" ---
    console.log('Capturing weather-app...');
    const weatherServer = await serveStatic(path.join(DIST, 'weather-app'), 9101, '/weather-app/');
    servers.push(weatherServer);
    await takeScreenshot(browser, 'http://localhost:9101/weather-app/', path.join(OUT, 'weather-app.png'), 9101);

    // --- WeatherEdit App — base href="/weatheredit-app/" ---
    console.log('Capturing weatheredit-app...');
    const weatherEditServer = await serveStatic(path.join(DIST, 'weatheredit-app'), 9102, '/weatheredit-app/');
    servers.push(weatherEditServer);
    await takeScreenshot(browser, 'http://localhost:9102/weatheredit-app/', path.join(OUT, 'weatheredit-app.png'), 9102);

    // --- Admin App — base href="/admin-app/" ---
    console.log('Capturing admin-app...');
    const adminServer = await serveStatic(path.join(DIST, 'admin-app'), 9103, '/admin-app/');
    servers.push(adminServer);
    await takeScreenshot(browser, 'http://localhost:9103/admin-app/', path.join(OUT, 'admin-app.png'), 9103);

    console.log('\nAll screenshots captured successfully!');
  } finally {
    await browser.close();
    for (const server of servers) {
      server.close();
    }
  }
}

main().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
