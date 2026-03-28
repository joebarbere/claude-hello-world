# Plan: Weather API Performance Benchmarks

## Goal

Establish baseline performance benchmarks for the Weather API REST endpoints using k6 load testing, with acceptance thresholds enforced in CI and historical baseline comparison to detect regressions.

## Current State

- **Weather API**: `apps/weather-api/Program.cs` defines a minimal API with endpoints under `/weatherforecast` (GET all, GET by ID, POST, PUT, DELETE) and `/minions` (full CRUD). It uses ASP.NET 9 with EF Core and Npgsql for Postgres.
- **Repository pattern**: Three repository implementations exist — `RandomWeatherForecastRepository` (default, in-memory random data), `InMemoryWeatherForecastRepository` (static list), and `EfWeatherForecastRepository` (Postgres via EF Core). The `Repository` config key selects the implementation.
- **Authentication middleware**: `apps/weather-api/Middleware/KratosAuthMiddleware.cs` runs on every request but likely passes through in test configurations.
- **Prometheus metrics**: The API already uses `app.UseHttpMetrics()` and `app.MapMetrics()` via the `prometheus-net` library, exposing request duration histograms.
- **Existing .NET tests**: `apps/weather-api-tests/` has unit tests for models and repositories using xUnit. No load or performance tests exist.
- **CI pipeline**: `.github/workflows/ci.yml` builds the API and runs unit tests. The EKS e2e workflow in `.github/workflows/eks-e2e.yml` starts the full pod stack with Postgres, runs Playwright tests, then tears down. No performance testing is done.
- **Container setup**: `apps/weather-api/project.json` defines `podman-build` (builds the container image) and `podman-up` (runs on port 5221). The EKS e2e workflow starts the API at `http://localhost:5221`.
- **No performance baselines exist.** There are no latency or throughput benchmarks, no k6/wrk scripts, and no regression detection.

## Implementation Steps

### 1. Install k6 and create the benchmark project

Create `apps/weather-api/benchmarks/` as the home for k6 test scripts.

k6 is chosen over wrk because:
- It supports scripted scenarios (not just URL bombardment).
- It has built-in threshold assertions (`http_req_duration`, `http_req_failed`).
- It outputs structured JSON for baseline comparison.
- It is a single Go binary with no runtime dependencies.

Create `apps/weather-api/benchmarks/package.json` (not a Node project, but documents the k6 version):

```json
{
  "name": "weather-api-benchmarks",
  "private": true,
  "scripts": {
    "bench": "k6 run main.js --out json=results.json"
  }
}
```

### 2. Create the k6 test script

Create `apps/weather-api/benchmarks/main.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics for granular tracking
const getLatency = new Trend('get_all_duration', true);
const getByIdLatency = new Trend('get_by_id_duration', true);
const postLatency = new Trend('post_duration', true);

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5221';

// --- Thresholds ---
// These are the acceptance criteria. CI will fail if any threshold is breached.
export const options = {
  scenarios: {
    // Scenario 1: Read-heavy baseline (typical usage pattern)
    read_heavy: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
      exec: 'readHeavy',
    },
    // Scenario 2: Write burst (simulates minion scheduler activity)
    write_burst: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      startTime: '35s',
      exec: 'writeBurst',
    },
    // Scenario 3: Mixed CRUD (realistic usage)
    mixed_crud: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 25 },
        { duration: '20s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      startTime: '55s',
      exec: 'mixedCrud',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],         // Global: 95th percentile < 500ms
    http_req_failed: ['rate<0.01'],           // Less than 1% error rate
    get_all_duration: ['p(95)<200'],          // GET /weatherforecast p95 < 200ms
    get_by_id_duration: ['p(95)<100'],        // GET /weatherforecast/:id p95 < 100ms
    post_duration: ['p(95)<500'],             // POST /weatherforecast p95 < 500ms
  },
};

// --- Scenario functions ---

export function readHeavy() {
  // 90% GET all, 10% GET by ID
  if (Math.random() < 0.9) {
    const res = http.get(`${BASE_URL}/weatherforecast`);
    getLatency.add(res.timings.duration);
    check(res, { 'GET all status 200': (r) => r.status === 200 });
  } else {
    const id = Math.floor(Math.random() * 100) + 1;
    const res = http.get(`${BASE_URL}/weatherforecast/${id}`);
    getByIdLatency.add(res.timings.duration);
    check(res, { 'GET by ID status 2xx': (r) => r.status >= 200 && r.status < 300 || r.status === 404 });
  }
  sleep(0.1);
}

export function writeBurst() {
  const payload = JSON.stringify({
    date: '2026-04-01',
    temperatureC: Math.floor(Math.random() * 50) - 10,
    summary: ['Freezing', 'Bracing', 'Cool', 'Mild', 'Warm', 'Hot'][Math.floor(Math.random() * 6)],
  });
  const params = { headers: { 'Content-Type': 'application/json' } };
  const res = http.post(`${BASE_URL}/weatherforecast`, payload, params);
  postLatency.add(res.timings.duration);
  check(res, { 'POST status 201': (r) => r.status === 201 });
  sleep(0.2);
}

export function mixedCrud() {
  const roll = Math.random();
  if (roll < 0.6) {
    const res = http.get(`${BASE_URL}/weatherforecast`);
    getLatency.add(res.timings.duration);
    check(res, { 'mixed GET status 200': (r) => r.status === 200 });
  } else if (roll < 0.8) {
    const payload = JSON.stringify({
      date: '2026-04-02',
      temperatureC: Math.floor(Math.random() * 40),
      summary: 'Mild',
    });
    const params = { headers: { 'Content-Type': 'application/json' } };
    const res = http.post(`${BASE_URL}/weatherforecast`, payload, params);
    postLatency.add(res.timings.duration);
    check(res, { 'mixed POST status 201': (r) => r.status === 201 });
  } else {
    const id = Math.floor(Math.random() * 50) + 1;
    const res = http.get(`${BASE_URL}/weatherforecast/${id}`);
    getByIdLatency.add(res.timings.duration);
  }
  sleep(0.1);
}
```

### 3. Create a database seeding script

Create `apps/weather-api/benchmarks/seed.sh`:

```bash
#!/bin/bash
# Seed the database with test data for meaningful benchmarks.
# Requires the Weather API to be running at $BASE_URL (default http://localhost:5221).
set -e

BASE_URL="${BASE_URL:-http://localhost:5221}"
SUMMARIES=("Freezing" "Bracing" "Chilly" "Cool" "Mild" "Warm" "Balmy" "Hot" "Sweltering" "Scorching")
COUNT="${SEED_COUNT:-1000}"

echo "Seeding $COUNT forecasts at $BASE_URL..."

for i in $(seq 1 $COUNT); do
  TEMP=$(( RANDOM % 60 - 10 ))
  SUMMARY=${SUMMARIES[$((RANDOM % ${#SUMMARIES[@]}))]}
  DATE=$(date -d "+$((RANDOM % 365)) days" +%Y-%m-%d 2>/dev/null || date -v+$((RANDOM % 365))d +%Y-%m-%d)

  curl -s -o /dev/null -X POST "$BASE_URL/weatherforecast" \
    -H 'Content-Type: application/json' \
    -d "{\"date\":\"$DATE\",\"temperatureC\":$TEMP,\"summary\":\"$SUMMARY\"}"

  if [ $((i % 100)) -eq 0 ]; then
    echo "  Seeded $i/$COUNT"
  fi
done

echo "Seeding complete."
```

### 4. Create the baseline comparison script

Create `apps/weather-api/benchmarks/compare-baseline.js`:

```javascript
/**
 * Compare k6 JSON output against a stored baseline.
 * Exit code 1 if any metric regressed by more than THRESHOLD_PCT.
 *
 * Usage: node compare-baseline.js results.json baseline.json
 */
const fs = require('fs');

const THRESHOLD_PCT = 20; // Allow 20% regression before failing

const [resultsPath, baselinePath] = process.argv.slice(2);

if (!resultsPath || !baselinePath) {
  console.log('Usage: node compare-baseline.js <results.json> <baseline.json>');
  process.exit(0); // No baseline = first run, pass
}

if (!fs.existsSync(baselinePath)) {
  console.log('No baseline found — this run establishes the baseline.');
  fs.copyFileSync(resultsPath, baselinePath);
  process.exit(0);
}

// Parse k6 JSON summary output (end-of-test summary lines)
function parseK6Summary(path) {
  const lines = fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const metrics = {};
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'Point' && obj.metric) {
        if (!metrics[obj.metric]) metrics[obj.metric] = [];
        metrics[obj.metric].push(obj.data.value);
      }
    } catch (e) { /* skip non-JSON lines */ }
  }
  return metrics;
}

const results = parseK6Summary(resultsPath);
const baseline = parseK6Summary(baselinePath);

let regressions = 0;

for (const metric of ['http_req_duration', 'get_all_duration', 'get_by_id_duration', 'post_duration']) {
  const current = results[metric];
  const base = baseline[metric];
  if (!current || !base) continue;

  const currentP95 = current.sort((a, b) => a - b)[Math.floor(current.length * 0.95)];
  const baseP95 = base.sort((a, b) => a - b)[Math.floor(base.length * 0.95)];

  if (!baseP95 || baseP95 === 0) continue;

  const change = ((currentP95 - baseP95) / baseP95) * 100;
  const status = change > THRESHOLD_PCT ? 'REGRESSION' : 'OK';

  console.log(`${metric} p95: ${baseP95.toFixed(1)}ms -> ${currentP95.toFixed(1)}ms (${change > 0 ? '+' : ''}${change.toFixed(1)}%) [${status}]`);

  if (change > THRESHOLD_PCT) regressions++;
}

if (regressions > 0) {
  console.error(`\nFAILED: ${regressions} metric(s) regressed by more than ${THRESHOLD_PCT}%`);
  process.exit(1);
} else {
  console.log('\nAll metrics within acceptable range.');
}
```

### 5. Add an Nx target

Add to `apps/weather-api/project.json`:

```json
"benchmark": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "bash apps/weather-api/benchmarks/seed.sh",
      "k6 run apps/weather-api/benchmarks/main.js --out json=apps/weather-api/benchmarks/results.json",
      "node apps/weather-api/benchmarks/compare-baseline.js apps/weather-api/benchmarks/results.json apps/weather-api/benchmarks/baseline.json"
    ],
    "cwd": "{workspaceRoot}",
    "parallel": false
  },
  "dependsOn": ["build"]
}
```

### 6. Add a CI workflow

Create `.github/workflows/benchmark.yml` (separate from `ci.yml` to avoid slowing down the main pipeline):

```yaml
name: API Performance Benchmark

on:
  pull_request:
    paths:
      - 'apps/weather-api/**'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

env:
  NX_NO_CLOUD: true

jobs:
  benchmark:
    runs-on: ubuntu-latest
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

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
            --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
            | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6

      # Build and start Weather API with InMemory repository (no Postgres needed)
      - name: Start Weather API (InMemory mode)
        run: |
          cd apps/weather-api
          dotnet run --configuration Release -- --Repository=InMemory --urls=http://localhost:5221 &
          echo $! > /tmp/api.pid

      - name: Wait for API to be ready
        run: |
          timeout 60 bash -c '
            until curl -sf http://localhost:5221/weatherforecast > /dev/null 2>&1; do
              sleep 2
            done'

      - name: Seed test data
        env:
          BASE_URL: http://localhost:5221
          SEED_COUNT: 1000
        run: bash apps/weather-api/benchmarks/seed.sh

      # Restore baseline from previous runs (cached as artifact)
      - name: Restore baseline
        uses: actions/cache@v5
        with:
          path: apps/weather-api/benchmarks/baseline.json
          key: benchmark-baseline-${{ github.base_ref || 'main' }}
          restore-keys: benchmark-baseline-

      - name: Run k6 benchmark
        run: k6 run apps/weather-api/benchmarks/main.js --out json=apps/weather-api/benchmarks/results.json

      - name: Compare against baseline
        run: node apps/weather-api/benchmarks/compare-baseline.js apps/weather-api/benchmarks/results.json apps/weather-api/benchmarks/baseline.json

      # On main branch, save results as the new baseline
      - name: Update baseline (main only)
        if: github.ref == 'refs/heads/main'
        run: cp apps/weather-api/benchmarks/results.json apps/weather-api/benchmarks/baseline.json

      - name: Save baseline to cache
        if: github.ref == 'refs/heads/main'
        uses: actions/cache/save@v5
        with:
          path: apps/weather-api/benchmarks/baseline.json
          key: benchmark-baseline-main

      - name: Stop Weather API
        if: always()
        run: kill $(cat /tmp/api.pid) 2>/dev/null || true

      # Comment benchmark results on PRs
      - name: Comment results on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v8
        with:
          script: |
            const fs = require('fs');
            let body = '## Performance Benchmark Results\n\n';

            try {
              // Read k6 stdout summary from the step output
              body += 'Benchmark completed. Check the workflow logs for detailed metrics.\n\n';
              body += '_Thresholds: GET all p95 < 200ms, GET by ID p95 < 100ms, POST p95 < 500ms_\n';
            } catch (e) {
              body += 'Could not parse benchmark results.\n';
            }

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });

      - name: Upload results artifact
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: benchmark-results
          path: apps/weather-api/benchmarks/results.json
          retention-days: 90
```

### 7. Add InMemory repository seeding support

The `InMemoryWeatherForecastRepository` needs to support `CreateAsync` for the seeding script to work. Check `apps/weather-api/Repositories/InMemoryWeatherForecastRepository.cs` — if it throws `NotSupportedException` on POST, the seeding step will fail. If so, the benchmark should use the `Random` repository instead (which also does not persist), or the benchmark should be run against the EfCore repository with Postgres.

**Alternative approach**: Run the benchmark against the full EKS pod stack (reuse the pattern from `eks-e2e.yml`). This is more realistic but adds 3-5 minutes of container build time. The plan above uses InMemory mode for speed; switch to the full stack once the benchmarks prove useful.

## Files to Create/Modify

- **Create** `apps/weather-api/benchmarks/main.js`
- **Create** `apps/weather-api/benchmarks/seed.sh`
- **Create** `apps/weather-api/benchmarks/compare-baseline.js`
- **Create** `.github/workflows/benchmark.yml`
- **Modify** `apps/weather-api/project.json` — add `benchmark` target

## Testing

1. **Local quick test**: Start the API with `dotnet run -- --Repository=InMemory --urls=http://localhost:5221`, seed 100 rows, run `k6 run main.js` with a reduced duration (add `--duration 5s --vus 5`). Verify output includes all custom metrics.
2. **Threshold validation**: Artificially add a `sleep(500)` to the GET endpoint, re-run the benchmark, and confirm k6 exits with a non-zero code because the `get_all_duration` threshold is breached.
3. **Baseline comparison**: Run twice — first run creates the baseline, second run compares. Verify the comparison script outputs metric deltas.
4. **CI**: Open a PR that touches `apps/weather-api/` and verify the benchmark workflow triggers and posts a comment.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CI runner performance varies, causing flaky threshold failures | Set generous thresholds (p95 < 500ms global) and use percentage-based regression detection (20% tolerance) rather than absolute values. |
| InMemory repository does not reflect real-world Postgres performance | Document this limitation. Add a `--profile=full` option that starts the full pod stack with Postgres. Use InMemory for CI regression detection, Postgres for periodic manual benchmarks. |
| k6 installation adds CI job time | The k6 binary is ~30 MB and installs in <15 seconds. Cache the apt packages if needed. |
| Benchmark results are noisy on shared CI runners | Average over 3 runs in CI (run k6 three times, take the median). Alternatively, accept that CI benchmarks are directional and rely on local runs for precise numbers. |
| Seeding 1000 rows via HTTP is slow (~30 seconds) | Acceptable for CI. For larger datasets, add a `/weatherforecast/batch` endpoint or seed directly via EF Core in a test harness. |
| The `benchmark.yml` workflow runs on every PR touching weather-api, adding ~3-4 minutes | The workflow is separate from `ci.yml` and only triggers on `apps/weather-api/**` path changes. It can also be switched to `workflow_dispatch` only if it becomes too noisy. |

## Dependencies

- None strictly required.
- **Benefits from**: "Add location to WeatherForecast" (IDEAS.md) — once the model has more fields, benchmarks will reflect the realistic payload size.
- **Benefits from**: "Local Playwright test fixtures for weather data" (IDEAS.md) — the seeding script here serves a similar purpose and could be shared.
- **Pairs well with**: "Liveness and readiness probes for all containers" (IDEAS.md) — health checks ensure the API is ready before benchmarks start.

## Estimated Complexity

**Medium** — The k6 script and CI workflow are straightforward, but tuning thresholds and baseline comparison logic requires iteration. The biggest unknown is CI runner performance variability. Estimated 3-5 hours of implementation.
