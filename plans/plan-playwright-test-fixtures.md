# Plan: Local Playwright Test Fixtures with Data Seeding

## Goal

Replace the minimal Playwright e2e tests with a robust fixture system that seeds deterministic test data via the weather API, authenticates through Ory Kratos, and tears down cleanly -- enabling reliable local and CI test runs.

## Current State

- **6 e2e projects** exist: `shell-e2e`, `weather-app-e2e`, `weatheredit-app-e2e`, `admin-app-e2e`, `lightning-app-e2e`, `weatherstream-app-e2e`.
- **Test quality is minimal**: most tests are scaffold-level (`has title` checks). Only `weather-app-e2e/src/eks.spec.ts` has meaningful tests (table headers, data rows, numeric temperatures).
- **No data seeding**: tests rely on whatever data the API happens to have. If the DB is empty, table tests will fail.
- **No auth handling**: Ory Kratos protects routes (Traefik config at `traefik/traefik-dynamic.yml` shows Kratos middleware). Tests currently bypass auth by hitting pages that may not require it, but the weatheredit and admin apps likely need sessions.
- **Playwright config** (`apps/weather-app-e2e/playwright.config.ts`) uses `baseURL: https://localhost:8443/weather-app/` with `ignoreHTTPSErrors: true`. No `globalSetup` or `storageState` is configured.
- **Weather API** is a .NET 9 app at `apps/weather-api/`. The `/weather` endpoint supports GET (list), POST (create), PUT (update), DELETE. Routed through Traefik at `https://localhost:8443/weather`.
- **Kratos public API** is available at `https://localhost:8443/.ory/kratos/public/` and admin at `https://localhost:8443/.ory/kratos/admin/` (per `traefik/traefik-dynamic.yml`).
- **No shared test utilities** exist across e2e projects.

## Implementation Steps

### 1. Create a shared e2e fixtures library

Create `libs/shared/e2e-fixtures/` with reusable utilities:

**`libs/shared/e2e-fixtures/src/api-client.ts`** -- typed HTTP client for the weather API:

```typescript
import { APIRequestContext } from '@playwright/test';

export interface WeatherForecast {
  id?: number;
  date: string;
  temperatureC: number;
  summary: string;
}

export class WeatherApiClient {
  constructor(
    private request: APIRequestContext,
    private baseUrl = 'https://localhost:8443'
  ) {}

  async createForecast(forecast: Omit<WeatherForecast, 'id'>): Promise<WeatherForecast> {
    const response = await this.request.post(`${this.baseUrl}/weather`, {
      data: forecast,
      ignoreHTTPSErrors: true,
    });
    if (!response.ok()) {
      throw new Error(`Failed to create forecast: ${response.status()} ${await response.text()}`);
    }
    return response.json();
  }

  async deleteForecast(id: number): Promise<void> {
    await this.request.delete(`${this.baseUrl}/weather/${id}`, {
      ignoreHTTPSErrors: true,
    });
  }

  async listForecasts(): Promise<WeatherForecast[]> {
    const response = await this.request.get(`${this.baseUrl}/weather`, {
      ignoreHTTPSErrors: true,
    });
    return response.json();
  }

  async deleteAll(): Promise<void> {
    const forecasts = await this.listForecasts();
    for (const f of forecasts) {
      if (f.id) await this.deleteForecast(f.id);
    }
  }
}
```

**`libs/shared/e2e-fixtures/src/seed-data.ts`** -- deterministic test data:

```typescript
import { WeatherForecast } from './api-client';

export const SEED_FORECASTS: Omit<WeatherForecast, 'id'>[] = [
  { date: '2025-01-15', temperatureC: -10, summary: 'Freezing' },
  { date: '2025-04-15', temperatureC: 12, summary: 'Cool' },
  { date: '2025-07-15', temperatureC: 32, summary: 'Hot' },
  { date: '2025-10-15', temperatureC: 18, summary: 'Mild' },
  { date: '2025-12-25', temperatureC: 2, summary: 'Chilly' },
];
```

**`libs/shared/e2e-fixtures/src/kratos-auth.ts`** -- Kratos session helper:

```typescript
import { APIRequestContext } from '@playwright/test';

const KRATOS_PUBLIC = 'https://localhost:8443/.ory/kratos/public';
const KRATOS_ADMIN = 'https://localhost:8443/.ory/kratos/admin';

export interface KratosIdentity {
  email: string;
  password: string;
}

export const TEST_USER: KratosIdentity = {
  email: 'e2e-test@example.com',
  password: 'SuperSecure123!',
};

/**
 * Create a test identity via the Kratos admin API if it doesn't exist.
 * Returns the identity ID.
 */
export async function ensureTestIdentity(
  request: APIRequestContext,
  user: KratosIdentity = TEST_USER
): Promise<string> {
  // List identities and check if test user exists
  const listResp = await request.get(`${KRATOS_ADMIN}/admin/identities`, {
    ignoreHTTPSErrors: true,
  });
  const identities = await listResp.json();
  const existing = identities.find(
    (i: any) => i.traits?.email === user.email
  );
  if (existing) return existing.id;

  // Create identity via admin API
  const createResp = await request.post(`${KRATOS_ADMIN}/admin/identities`, {
    data: {
      schema_id: 'default',
      traits: { email: user.email },
      credentials: {
        password: { config: { password: user.password } },
      },
    },
    ignoreHTTPSErrors: true,
  });
  const identity = await createResp.json();
  return identity.id;
}

/**
 * Perform a Kratos login flow and return the session cookie value.
 * This can be used with Playwright's storageState to authenticate pages.
 */
export async function loginViaKratos(
  request: APIRequestContext,
  user: KratosIdentity = TEST_USER
): Promise<string> {
  // 1. Initiate a login flow
  const flowResp = await request.get(
    `${KRATOS_PUBLIC}/self-service/login/api`,
    { ignoreHTTPSErrors: true }
  );
  const flow = await flowResp.json();

  // 2. Submit credentials
  const submitResp = await request.post(
    `${KRATOS_PUBLIC}/self-service/login?flow=${flow.id}`,
    {
      data: {
        method: 'password',
        identifier: user.email,
        password: user.password,
      },
      ignoreHTTPSErrors: true,
    }
  );

  const session = await submitResp.json();
  return session.session_token;
}
```

### 2. Create a Playwright global setup for auth

Create `libs/shared/e2e-fixtures/src/global-setup.ts`:

```typescript
import { chromium, FullConfig } from '@playwright/test';
import { ensureTestIdentity, loginViaKratos, TEST_USER } from './kratos-auth';

const AUTH_STATE_PATH = 'playwright/.auth/user.json';

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Ensure test identity exists
  const request = context.request;
  await ensureTestIdentity(request, TEST_USER);

  // Login and save browser storage state
  const page = await context.newPage();

  // Navigate to login page, fill credentials, submit
  await page.goto('https://localhost:8443/');
  // ... fill login form based on app's UI
  // For API-based auth (headless), use the Kratos API directly:
  const sessionToken = await loginViaKratos(request, TEST_USER);

  // Set the session cookie
  await context.addCookies([{
    name: 'ory_kratos_session',
    value: sessionToken,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);

  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();
}

export default globalSetup;
```

### 3. Create seed and teardown scripts

**`libs/shared/e2e-fixtures/src/fixtures.ts`** -- Playwright test fixtures:

```typescript
import { test as base, expect } from '@playwright/test';
import { WeatherApiClient } from './api-client';
import { SEED_FORECASTS } from './seed-data';

type TestFixtures = {
  apiClient: WeatherApiClient;
  seededData: { ids: number[] };
};

export const test = base.extend<TestFixtures>({
  apiClient: async ({ request }, use) => {
    const client = new WeatherApiClient(request);
    await use(client);
  },

  seededData: async ({ apiClient }, use) => {
    // Seed: create test forecasts
    const ids: number[] = [];
    for (const forecast of SEED_FORECASTS) {
      const created = await apiClient.createForecast(forecast);
      if (created.id) ids.push(created.id);
    }

    // Provide the seeded data to the test
    await use({ ids });

    // Teardown: delete all seeded forecasts
    for (const id of ids) {
      await apiClient.deleteForecast(id);
    }
  },
});

export { expect };
```

### 4. Update e2e projects to use fixtures

Example: update `apps/weather-app-e2e/src/example.spec.ts`:

```typescript
import { test, expect } from '@shared/e2e-fixtures';

test.describe('weather-app with seeded data', () => {
  test('displays forecast table with seeded rows', async ({ page, seededData }) => {
    await page.goto('/');
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });

    const rows = page.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(seededData.ids.length);
  });

  test('shows correct temperature values from seed data', async ({ page, seededData }) => {
    await page.goto('/');
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });

    // Verify "Hot" row exists with 32 degrees
    await expect(page.locator('tbody').getByText('Hot')).toBeVisible();
    await expect(page.locator('tbody').getByText('32')).toBeVisible();
  });
});
```

### 5. Update Playwright configs to use global setup and auth state

Edit each e2e project's `playwright.config.ts`:

```typescript
import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';
import path from 'path';

const baseURL = process.env['BASE_URL'] || 'https://localhost:8443/weather-app/';

export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  globalSetup: path.join(workspaceRoot, 'libs/shared/e2e-fixtures/src/global-setup.ts'),
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    // Use saved auth state for all tests
    storageState: 'playwright/.auth/user.json',
  },
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }], ['junit', { outputFile: 'playwright-report/junit.xml' }]]
    : undefined,
  ...(process.env['BASE_URL'] ? {} : {
    webServer: {
      command: 'npx nx run weather-app:serve',
      url: 'http://localhost:4201',
      reuseExistingServer: true,
      cwd: workspaceRoot,
    },
  }),
  projects: [
    // Auth setup project (runs first, no auth state)
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { storageState: undefined },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
```

### 6. Add `.gitignore` entry for auth state

Append to `.gitignore`:

```
playwright/.auth/
```

### 7. Create an Nx library project for e2e-fixtures

Generate via Nx or create manually:

- `libs/shared/e2e-fixtures/project.json`
- `libs/shared/e2e-fixtures/tsconfig.json`
- `libs/shared/e2e-fixtures/package.json`
- Add a TypeScript path alias in `tsconfig.base.json`: `"@shared/e2e-fixtures": ["libs/shared/e2e-fixtures/src/index.ts"]`

### 8. Add CI integration

Update `.github/workflows/ci.yml` to add an e2e job that uses seeded data:

```yaml
  e2e-tests:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: 'npm'
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: '9.0.x'
      - run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Start API stack
        run: npx nx kube-up shell
      - name: Wait for API health
        run: |
          for i in $(seq 1 30); do
            curl -sk https://localhost:8443/weather && break
            sleep 2
          done
      - name: Run e2e tests
        run: npx nx run-many --target=e2e --projects=weather-app-e2e,admin-app-e2e --parallel=1
      - name: Upload Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: '**/playwright-report/'
      - name: Tear down
        if: always()
        run: npx nx kube-down shell
```

## Files to Create/Modify

- **Create** `libs/shared/e2e-fixtures/src/index.ts` -- barrel export
- **Create** `libs/shared/e2e-fixtures/src/api-client.ts` -- weather API client
- **Create** `libs/shared/e2e-fixtures/src/seed-data.ts` -- deterministic test data
- **Create** `libs/shared/e2e-fixtures/src/kratos-auth.ts` -- Kratos authentication helpers
- **Create** `libs/shared/e2e-fixtures/src/global-setup.ts` -- Playwright global setup
- **Create** `libs/shared/e2e-fixtures/src/fixtures.ts` -- Playwright test fixture extensions
- **Create** `libs/shared/e2e-fixtures/project.json`
- **Create** `libs/shared/e2e-fixtures/tsconfig.json`
- **Modify** `tsconfig.base.json` -- add `@shared/e2e-fixtures` path alias
- **Modify** `apps/weather-app-e2e/playwright.config.ts` -- add global setup, auth state
- **Modify** `apps/admin-app-e2e/playwright.config.ts` -- same
- **Modify** `apps/weatheredit-app-e2e/playwright.config.ts` -- same
- **Modify** `apps/weather-app-e2e/src/example.spec.ts` -- use fixtures, seed data
- **Modify** `apps/admin-app-e2e/src/example.spec.ts` -- use fixtures
- **Modify** `.gitignore` -- exclude `playwright/.auth/`
- **Modify** `.github/workflows/ci.yml` -- add `e2e-tests` job

## Testing

1. **Unit test the API client**: Create a quick test that calls `WeatherApiClient.createForecast()` and `deleteForecast()` against a running API. Verify the forecast appears in `listForecasts()` and is gone after delete.
2. **Auth flow**: Run `global-setup.ts` manually and verify `playwright/.auth/user.json` contains a valid Kratos session cookie.
3. **Seeded e2e test**: Run `npx nx e2e weather-app-e2e` with the stack up. Verify tests pass and the table contains the seeded data.
4. **Teardown**: After the test run, call `GET /weather` and verify seeded forecasts have been deleted (only pre-existing data remains).
5. **Parallel safety**: Run two e2e projects in sequence (not parallel, since they share the same API) and verify no data conflicts.
6. **CI**: Push a branch and verify the `e2e-tests` job starts the stack, runs tests, and tears down.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Kratos login flow may differ between browser-based and API-based approaches | Implement both paths: `loginViaKratos` for headless API auth, and a browser-based login in `global-setup.ts` as fallback. Test which one the app actually expects. |
| Seed data may conflict with data from other sources (e.g., Debezium CDC) | Use distinctive values (negative IDs or unique summaries like "E2E-Freezing") so seeded data is identifiable. Teardown deletes only seeded rows by ID. |
| The weather API may require auth for POST/DELETE but not GET | Check Traefik middleware config. If auth is required for mutations, the seed script needs to pass the Kratos session cookie. The `APIRequestContext` from Playwright handles this via `storageState`. |
| `storageState` JSON file path may differ between local and CI | Use a relative path (`playwright/.auth/user.json`) that works in both environments. Add to `.gitignore`. |
| Global setup runs once but session may expire during long test suites | Kratos sessions default to long TTL (24h). For extra safety, re-authenticate in a `setup` project dependency. |
| The stack may not be running when e2e tests execute locally | Document the prerequisite: `npx nx kube-up shell` before running e2e. Optionally, add the webServer config as a fallback (current behavior). |

## Dependencies

- **Benefits from**: `plan-nx-kube-targets.md` -- granular `kube-up` targets make it easier to bring up just the API stack for e2e tests without starting kafka/datascience/observability.
- **No hard blockers**: can be implemented with the current monolithic `shell:kube-up` target.

## Estimated Complexity

**Large** -- requires a new shared library, auth integration with Kratos, seed/teardown lifecycle management, updates to all 6 e2e projects, and CI pipeline changes. Should be broken into sub-PRs:
1. Create `e2e-fixtures` library with API client and seed data (no auth)
2. Add Kratos auth to global setup
3. Migrate each e2e project one at a time
4. Add CI e2e job
