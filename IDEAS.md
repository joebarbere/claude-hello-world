# Ideas

Ideas are loosely grouped by theme. Each entry notes motivation, implementation
considerations, risks, and dependencies on other ideas where relevant.

---

## Infrastructure & Stack Hygiene

### Use Postgres for Airflow metadata — [Plan](plans/plan-airflow-postgres-metadata.md)

**Motivation:** Airflow currently uses SQLite with SequentialExecutor
(`datascience-pod.yaml`). SQLite is single-writer and cannot support the
LocalExecutor or CeleryExecutor, which means all DAG tasks run serially even
when the task graph allows parallelism. Moving metadata to Postgres unlocks
LocalExecutor (multi-process, same host) with minimal operational overhead.

**Implementation notes:**
- Change `AIRFLOW__CORE__EXECUTOR` to `LocalExecutor` and
  `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` to a Postgres DSN pointing at
  `host.containers.internal:5432`.
- Provision a dedicated `airflow` database and user in the Postgres init
  scripts — keep it separate from `appdb` to avoid schema conflicts.
- Run `airflow db migrate` on first start; the Airflow image `entrypoint.sh`
  already handles this idiom.
- The "check" short-circuit tasks in `dag_download_weather.py` rely on MinIO
  idempotency, not SQLite state, so no DAG logic changes are needed.

**Risks:** Airflow now depends on Postgres being healthy before it can start.
Add a readiness check or `depends_on` equivalent in the pod manifest.

**Depends on:** "Separate out the Postgres container" (below), otherwise
Postgres and datascience are in the same lifecycle.

---

### Lightweight pgAdmin container — [Plan](plans/plan-pgadmin-container.md)

**Motivation:** Ad-hoc SQL inspection of `appdb` currently requires `psql`
inside the container or a local client. pgAdmin gives a browser-based query
tool that is useful during development and for checking CDC table contents in
DuckDB-adjacent workflows.

**Implementation notes:**
- Use `dpage/pgadmin4` (well-maintained, small footprint).
- Mount a `servers.json` file so the `appdb` connection is pre-configured on
  first launch — avoids manual setup after every `kube play`.
- Expose through Traefik at `/pgadmin` with strip-prefix middleware (same
  pattern as Airflow and Kafka UI).
- For authentication: pgAdmin has its own basic login. If SSO is required,
  Traefik's ForwardAuth middleware can gate access using the Ory Kratos
  `/sessions/whoami` endpoint — the same pattern used by the auth-proxy in
  `apps/observability/auth-proxy`. Only users with the `admin` role should
  reach it.
- Add a link card to the admin-app with category "Infrastructure" and a
  health badge pointing at `/pgadmin/misc/ping`.

**Risks:** pgAdmin can be slow to start in constrained environments. The
container image is ~300 MB. Consider `sosedoff/pgweb` as a lighter alternative
if the richer pgAdmin feature set is not needed.

**Depends on:** "Separate out the Postgres container" is not a hard dependency,
but it makes the deployment story cleaner.

---

### Separate out the Postgres container into a new stack — [Plan](plans/plan-separate-postgres-stack.md)

**Motivation:** `postgres-pod.yaml` already exists as a standalone pod, but the
main stack (apps-pod) implicitly expects Postgres to be running. Making the
dependency explicit and the pod independently manageable allows Postgres to be
upgraded, backed up, or restarted without touching the application stack. It
also lets the database be started once and kept running across app stack
teardowns during development.

**Implementation notes:**
- Document the required startup order in `RUN.md`: postgres -> ory-kratos ->
  apps -> datascience -> kafka -> observability.
- Add a health-check `initContainer` or startup probe to the apps-pod and
  ory-kratos-pod that retries `pg_isready` before the main containers start.
- GitHub Actions e2e workflow must `kube play` postgres-pod.yaml before
  apps-pod.yaml. Check `.github/workflows/` to confirm the order and add an
  explicit wait step (`pg_isready` loop or `kubectl wait`).
- Consider a `kube-up.sh` script that encodes the correct startup sequence so
  developers do not need to remember the order.

**Risks:** If the CI workflow currently relies on everything being in one pod,
inter-pod networking via `host.containers.internal` must be verified in the
GitHub Actions runner environment.

---

### Separate out the Ory Kratos container into a new stack — [Plan](plans/plan-separate-kratos-stack.md)

**Motivation:** Same rationale as Postgres separation. Kratos runs a migration
`initContainer` on every start. Keeping it in a separate pod lets identity
infrastructure be versioned and upgraded independently of the application layer.

**Implementation notes:**
- `ory-kratos-pod.yaml` already exists. The concern is sequencing: Kratos
  needs Postgres, and the apps-pod needs Kratos for the auth middleware.
- Add a readiness gate in apps-pod (HTTP check against Kratos
  `/.well-known/ory/webauthn.js` or the `/health/ready` endpoint) before the
  weather-api container is considered live.
- The `kratos-migrate` initContainer uses `host.containers.internal:5432` —
  this already works across pods.
- GitHub Actions: the e2e workflow needs `kube play ory-kratos-pod.yaml` after
  Postgres is healthy and before apps-pod is started.

**Risks:** Same cross-pod networking concern as the Postgres separation. Test
in CI explicitly.

---

### kube-up.sh / kube-down.sh lifecycle scripts — [Plan](plans/plan-lifecycle-scripts.md)

**Motivation:** As the number of pods grows (postgres, ory-kratos, kafka,
datascience, observability, apps), manually remembering startup order becomes
error-prone. A pair of shell scripts encoding the correct sequence saves
developer time and prevents "why is auth broken?" debugging sessions.

**Implementation notes:**
- `kube-up.sh`: play pods in dependency order, with `pg_isready` and HTTP
  health-check waits between stages.
- `kube-down.sh`: stop in reverse order.
- Accept an optional `--stack=<name>` flag to start/stop a single pod for
  targeted iteration.
- The existing `scripts/` directory is the right home.
- `RUN.md` should reference the scripts rather than listing manual commands.

---

## Data Ingestion — DAGs

### DAG to collect weather data from weather.gov — [Plan](plans/plan-dag-weather-gov.md)

**Motivation:** The National Weather Service API (`api.weather.gov`) provides
official US point forecasts, hourly observations, and active alerts for any
US latitude/longitude — all with no API key. This is the canonical authoritative
source for US forecast data and would complement the historical GHCN and
Open-Meteo data already collected.

**Implementation notes:**
- NWS API workflow for a point: `GET /points/{lat},{lon}` returns station
  metadata including `forecastHourly` and `observationStations` URLs.
  Cache the point response in MinIO to avoid re-fetching on every run.
- Fetch hourly forecasts for the five US locations already in
  `OPEN_METEO_LOCATIONS` (New York, Los Angeles). Store as JSON in
  `weather-raw/nws/{location}/{YYYY-MM-DD}.json`.
- Fetch current observations from the nearest observation station.
- Fields available: temperature (F, convert to C), wind speed/direction,
  relative humidity, barometric pressure, visibility, cloud layers,
  precipitation last hour, and textual forecast descriptions.
- Schedule: hourly for current observations, daily for multi-day forecasts.
- Respect NWS rate limits: the API asks for a `User-Agent` header with a
  contact email. Add this to the request.
- Add `nws_helper.py` to `apps/datascience/shared/` following the same
  contract as `weather_sources.py`.

**Risks:** The NWS API only covers US locations. Non-US cities in the streaming
events (London, Tokyo, etc.) would need a different source. The API
occasionally returns 503 during high-demand severe weather events.

**Depends on:** MinIO bucket structure established by `dag_download_weather.py`.

---

### DAG to collect weather data from NOAA — [Plan](plans/plan-dag-noaa.md)

**Motivation:** The existing `dag_download_weather.py` already pulls GHCN-Daily
CSVs from NOAA's HTTPS mirror — which is the NOAA dataset. This idea likely
refers to a complementary NOAA source such as:
- **NOAA Climate Data Online (CDO) API**: structured API with JSON responses,
  supports hourly ASOS (Automated Surface Observing System) data.
- **NOAA ISD (Integrated Surface Database)**: raw hourly surface observations
  globally, good for wind and pressure data not in GHCN-Daily.
- The linked scraper (`maheshbabugorantla/NOAA-Weather-Data-Scraper`) targets
  the CDO web interface — prefer the CDO API directly instead.

**Implementation notes:**
- CDO API requires a free token (register at `www.ncdc.noaa.gov/cdo-web/token`).
  Store the token as a Kubernetes Secret or Airflow Variable, not hardcoded.
- ISD data is available as gzipped fixed-width files per station per year at
  `https://www.ncei.noaa.gov/data/global-hourly/access/`. Parse with `pandas`
  and the `isd-parser` library.
- Prioritise ISD for the stations already in `GHCN_STATIONS` to get hourly
  resolution wind and pressure data that GHCN-Daily does not include.
- Store in `weather-raw/isd/{station_id}/{year}.parquet` (Parquet is more
  efficient than CSV for time-series with many columns).

**Risks:** ISD files can be 50-200 MB per station per year. Disk and MinIO
storage budgets need consideration. Parse only the columns needed.

**Depends on:** `dag_download_weather.py` station list (`GHCN_STATIONS`).

---

### DAG to web scrape Weather Underground data — [Plan](plans/plan-dag-weather-underground.md)

**Motivation:** Weather Underground's Personal Weather Station (PWS) network
provides hyper-local observations from amateur stations — often more granular
than official NOAA stations. This is the only way to get neighborhood-level
data.

**Implementation notes:**
- Validate the station ID before any scraping attempt. A separate "list valid
  station IDs" DAG (as noted in the original idea) should populate a MinIO
  JSON file that this DAG reads. Stations change — re-validate weekly.
- Request cadence: one successful run per calendar day per station, honoring
  the spirit of the `robots.txt`. Use a ShortCircuitOperator that checks for
  today's object in MinIO before fetching.
- Add a random jitter (5-30 seconds) between station requests and a polite
  `User-Agent` header.
- The example code at `zperzan.github.io` scrapes the `/history/daily` page.
  Weather Underground's unofficial JSON endpoint
  (`/api/v1/history/daily?stationId=...`) is more stable than HTML scraping —
  check whether it is still accessible before investing in HTML parsing.
- Store raw responses in `weather-raw/wunderground/{station_id}/{YYYY-MM-DD}.json`.
- Add a station metadata file to MinIO listing which stations correspond to
  which cities in the streaming event set.

**Risks:** Weather Underground actively rate-limits and blocks scrapers. The
page structure changes without notice. This DAG has the highest maintenance
burden of any ingestion source. Consider it a "nice to have" and prioritise
the API-based sources first. Budget time for ongoing maintenance.

**Depends on:** "DAG to list valid Weather Underground station IDs" (new idea
below).

---

### DAG to list valid Weather Underground station IDs — [Plan](plans/plan-dag-station-ids.md)

**Motivation:** The scraping DAG needs a curated list of station IDs. Weather
Underground's station search can be queried by city name to enumerate nearby
PWS stations. This supporting DAG produces and maintains that list.

**Implementation notes:**
- Query `https://api.weather.com/v3/location/search?query={city}` (the
  Weather Channel / Weather Underground backend) for each of the 10 streaming
  event cities.
- Filter for stations with data in the last 7 days (staleness check).
- Persist the validated list to `weather-raw/wunderground/station_index.json`.
- Schedule: weekly (Sunday 00:00 UTC) — station lists are stable.

---

### DAG to fetch Open-Meteo forecast data (not just historical) — [Plan](plans/plan-dag-open-meteo-forecast.md)

**Motivation:** The current `dag_download_weather.py` fetches historical data
from the Open-Meteo archive API (2020-2024). Open-Meteo also offers a free
7-day forecast API with no key required. Ingesting forecasts would let the
platform compare what was predicted against what actually happened.

**Implementation notes:**
- Use `https://api.open-meteo.com/v1/forecast` with the same `daily` variables
  already defined in `OPEN_METEO_DAILY_VARIABLES`.
- Extend `weather_sources.py` with a `download_open_meteo_forecast()` function.
- Store in `weather-raw/open-meteo-forecast/{location}/{YYYY-MM-DD}.json` with
  the run date in the filename (so forecasts are versioned and forecast skill
  can be evaluated later).
- Schedule: daily at 01:00 UTC (after model initialization, before the
  historical download at 02:00).

---

## Data Quality & Analytics

### Quality score trend dashboard in Grafana — [Plan](plans/plan-quality-score-dashboard.md)

**Motivation:** `dag_quality_report.py` produces a daily JSON quality score
(0-100) and saves it to MinIO. This score is currently only visible by
manually reading the MinIO object. A Grafana dashboard that plots the score
over time would make the impact of data science improvements immediately
visible.

**Implementation notes:**
- Options for getting the score into Grafana:
  1. Push the score as a Prometheus gauge metric from the DAG (simplest if
     the Prometheus pushgateway is available).
  2. Create a new Grafana data source pointing at a small Flask/FastAPI
     endpoint that reads the latest report from MinIO and returns JSON in
     Infinity plugin format.
  3. Add a new Airflow task that writes the score to a Postgres table; use
     Grafana's existing Postgres data source.
- Option 3 is the most consistent with the existing stack. A single-table
  `quality_scores(run_date DATE, score FLOAT, details JSONB)` in Postgres
  requires an EF Core migration if it is to be accessed from the .NET API,
  or it can be a raw Postgres table managed by the DAG alone.
- Add the new dashboard JSON to `apps/observability/grafana/provisioning/dashboards/`.

**Risks:** If the DAG is on SequentialExecutor writing to SQLite, a Postgres
write task works cleanly. After the Postgres executor migration this is trivial.

**Depends on:** "Use Postgres for Airflow metadata" is not a hard dependency,
but "Airflow writes to Postgres" requires Postgres to be accessible from the
DAG, which it already is via `host.containers.internal`.

---

### DAG to validate ingested weather data against climatological norms — [Plan](plans/plan-dag-data-validation.md)

**Motivation:** Downloaded data can contain sensor errors, missing values, or
API anomalies. A validation DAG catches gross outliers (e.g., temperature of
999°C from a sensor fault) before they corrupt profiles and quality scores.

**Implementation notes:**
- For each ingested CSV/JSON in MinIO, compute per-column statistics and
  compare against climatological bounds:
  - Air temperature: -70°C to +60°C globally; tighter city-specific bounds
    from the profiles in `weather-analytics/profiles/weather_profiles_v1.json`.
  - Relative humidity: 0-100%.
  - Wind speed: 0-400 km/h (highest ever recorded gust was ~408 km/h).
  - Precipitation: 0-300 mm/hr (extreme but physically possible).
- Flag rows that fail bounds checks; write a validation report to
  `weather-analytics/validation/{source}/{YYYY-MM-DD}.json`.
- Emit a count of flagged rows as a Prometheus metric so Grafana can alert on
  data quality regressions.
- Schedule: trigger after each ingestion DAG completes (use Airflow's
  `TriggerDagRunOperator` or dataset-based scheduling).

---

### Notebook 05: Forecast skill evaluation — [Plan](plans/plan-notebook-forecast-skill.md)

**Motivation:** Once the platform stores both Open-Meteo forecasts (what was
predicted) and GHCN/ISD actuals (what happened), forecast skill can be
measured. Mean Absolute Error (MAE) and Root Mean Square Error (RMSE) for
temperature forecasts at each lead time (day+1 through day+7) are standard
metrics.

**Implementation notes:**
- Load forecast CSVs and actual CSVs from MinIO into DataFrames.
- Join on `(location, date)`.
- Plot MAE by lead time — the classic "error growth" curve.
- Compare the Open-Meteo model skill against the minion-generated forecasts
  from the quality report as a baseline.
- Save the evaluation results as a new profile artifact in `weather-analytics/`.

---

### Incremental/delta ingestion for GHCN-Daily — [Plan](plans/plan-incremental-ghcn.md)

**Motivation:** The current DAG downloads the entire station history CSV on
every run (files can be tens of MB per station). For daily operational use
only the new rows are needed.

**Implementation notes:**
- Track the latest ingested date per station in a Postgres or DuckDB metadata
  table.
- Download the full CSV (GHCN does not offer a delta endpoint) but use pandas
  to filter to only new rows before uploading and inserting.
- This reduces DuckDB upsert time and MinIO storage growth significantly over
  time.

---

## Platform Observability & Reliability

### Airflow health metrics in Prometheus — [Plan](plans/plan-airflow-prometheus-metrics.md)

**Motivation:** Airflow exposes a `/health` JSON endpoint and, in newer
versions, a StatsD exporter or a Prometheus metrics endpoint. DAG failures
are currently only visible by logging into the Airflow UI — there is no alert
if a DAG fails silently.

**Implementation notes:**
- Enable Airflow's built-in metrics: set
  `AIRFLOW__METRICS__STATSD_ON=true` and run a StatsD exporter sidecar, or
  use the `apache-airflow-providers-prometheus` package which exposes a
  `/metrics` endpoint directly.
- Add Airflow to `prometheus.yml` as a scrape target.
- Create a Grafana panel for DAG success/failure rates and task duration.
- Set a Grafana alert: if any DAG has had no successful run in the last 48
  hours, fire an alert.

---

### MinIO metrics in Prometheus — [Plan](plans/plan-minio-prometheus-metrics.md)

**Motivation:** MinIO exposes a Prometheus-compatible `/minio/v2/metrics/cluster`
endpoint. Storage usage, request rates, and error rates are not currently
visible in Grafana.

**Implementation notes:**
- Add MinIO as a scrape target in `prometheus.yml`. MinIO requires a bearer
  token for the metrics endpoint; generate one with `mc admin prometheus
  generate local`.
- Add a storage dashboard panel to the existing `system-health.json` Grafana
  dashboard, or create a dedicated `minio.json` dashboard.

---

### Liveness and readiness probes for all containers — [Plan](plans/plan-liveness-readiness-probes.md)

**Motivation:** Podman `kube play` supports liveness and readiness probes in
the pod YAML. Without probes, a container that has started but is not yet
serving traffic will receive requests too early, causing cascading failures
on startup.

**Implementation notes:**
- Weather API: `httpGet /health` (already implemented if the ASP.NET health
  check middleware is wired up).
- Kafka broker: `exec kafka-broker-api-versions.sh --bootstrap-server localhost:9092`.
- Schema Registry: `httpGet /subjects`.
- Airflow: `httpGet /health` on port 8080.
- Kratos: `httpGet /health/ready` on port 4433.
- Add probes to all pod YAML files in `k8s/`.

---

### Automated pod restart / self-healing script — [Plan](plans/plan-self-healing-script.md)

**Motivation:** In a Podman kube play environment there is no Kubernetes
controller to restart failed pods. A lightweight cron job or systemd timer
on the host can check pod health and replay the pod YAML if a pod has exited.

**Implementation notes:**
- `scripts/health-watch.sh`: check `podman pod ps` every 5 minutes; if any
  pod is not in Running state, log the event and re-apply its pod YAML.
- Not a replacement for a proper orchestrator, but appropriate for a local
  dev platform that needs to survive overnight without manual intervention.

---

## Security

### Rotate hardcoded credentials — [Plan](plans/plan-rotate-credentials.md)

**Motivation:** The pod YAML files contain hardcoded passwords
(`apppassword`, `datascience-dev-key`, `admin/admin` for Airflow). These are
fine for local development but are a risk if the repository is cloned and
deployed without review.

**Implementation notes:**
- Move secrets to a `.env` file (gitignored) or Podman secrets.
  `podman secret create` stores secrets in the local secrets store.
  Reference them in pod YAML with `secretKeyRef`.
- Add a `.env.example` file to the repository documenting required variables.
- Add a `git-secrets` or `gitleaks` pre-commit hook to catch accidental
  credential commits.
- For GitHub Actions, move secrets to repository secrets and inject them as
  environment variables.

---

### Traefik TLS certificate management — [Plan](plans/plan-tls-certificate-management.md)

**Motivation:** The current setup uses a self-signed certificate in `ssl/`.
This causes browser warnings and makes automated testing awkward (requires
`--ignore-certificate-errors` flags).

**Implementation notes:**
- For local development: use `mkcert` to generate a locally-trusted
  certificate. Add the `mkcert` CA to the system trust store once.
- For a deployed environment: configure Traefik's ACME provider to obtain
  a Let's Encrypt certificate automatically. This requires a public domain
  name and port 80/443 accessibility.
- Document both options in `RUN.md`.

---

### Ory Kratos identity schema validation in CI — [Plan](plans/plan-kratos-schema-ci-validation.md)

**Motivation:** Kratos identity schemas are JSON files that are easy to break
silently. A CI step that validates schemas and runs `kratos migrate sql --dry-run`
would catch regressions before deployment.

**Implementation notes:**
- Add a GitHub Actions job that builds the Kratos container and runs
  `kratos validate identity-schema` against all schema files.
- Add schema tests to `weather-api-tests`.

---

## Developer Experience

### Hot-reload for DAG development — [Plan](plans/plan-dag-hot-reload.md)

**Motivation:** The Airflow container mounts DAG files from the host via a
hostPath volume, so file changes are reflected in Airflow without a container
restart. However, syntax errors in DAGs cause the entire scheduler to emit
import errors that are not surfaced prominently. A pre-save linting step in
the developer's editor (or a `pre-commit` hook) would catch Python syntax
errors before they reach Airflow.

**Implementation notes:**
- Add `flake8` and `pylint` configuration to `apps/datascience/`.
- Add a `pre-commit` hook: `python -m py_compile apps/datascience/airflow/dags/*.py`.
- Consider adding `pytest` tests for the helper functions in
  `apps/datascience/shared/` — they are pure Python and easy to unit test
  with mocked HTTP responses (`responses` library).

---

### Nx task for `kube play` and `kube down` — [Plan](plans/plan-nx-kube-targets.md)

**Motivation:** Developers currently run `podman kube play` manually. Wrapping
the pod lifecycle in Nx targets (`nx run apps:up`, `nx run kafka:down`) would
integrate pod management into the same workflow as `nx build` and `nx test`.

**Implementation notes:**
- Add a `project.json` executor target using `nx:run-commands` for each pod
  folder under `k8s/`.
- A root-level `kube-up` target can depend on all individual pod targets with
  the correct ordering encoded in the `dependsOn` array.
- This also makes the CI workflow cleaner: replace shell commands with `nx run`
  invocations.

---

### Local Playwright test fixtures for weather data — [Plan](plans/plan-playwright-test-fixtures.md)

**Motivation:** The Playwright e2e tests in `weather-app-e2e` and
`weatheredit-app-e2e` rely on whatever data is in the database at test time.
This makes tests flaky. A test fixture DAG or API seeding script would give
tests a deterministic starting state.

**Implementation notes:**
- Add a `scripts/seed-test-data.sh` that calls the Weather API to POST a
  known set of forecasts before e2e tests run.
- Add a teardown step that deletes seeded records by a known tag or date range.
- The admin user credentials for write operations are already available in the
  CI environment via Kratos.

---

## WeatherForecast Data Model Enhancements

### Add location to WeatherForecast — [Plan](plans/plan-add-location-field.md)

**Motivation:** The `WeatherForecast` entity has no location field. The
streaming events reference 10 cities by name, but forecasts created via the
CRUD API have no geographic context. Without a location, it is impossible to
compare forecasts to actuals from the ingestion DAGs or to display forecasts
on a map.

**Implementation notes:**
- Add `Location` (string, max 100 chars, nullable for backward compatibility)
  and optionally `Latitude` / `Longitude` (double, nullable) to the
  `WeatherForecast` model.
- EF Core migration required. The Debezium CDC connector will automatically
  capture the new columns in Kafka events after the schema change.
- The Schema Registry Avro schema for the `WeatherForecasts` topic will need
  to be evolved (add nullable fields — backward-compatible change).
- Update the weatheredit-app form to include a location dropdown populated
  from the 10 streaming cities.
- Update the weather-app table to display the location column.

**Risks:** This is a breaking change to the Avro schema if not handled as an
additive evolution. Coordinate with the Kafka/Debezium configuration.

**Depends on:** EF Core migration, Kafka schema evolution.

---

### Add humidity and wind speed to WeatherForecast — [Plan](plans/plan-add-humidity-wind.md)

**Motivation:** The streaming events already carry `humidity` and `windSpeed`
fields, but the `WeatherForecast` entity stored in Postgres does not. Persisting
these fields closes the gap between the ephemeral streaming data and the durable
forecast record.

**Implementation notes:**
- Add `HumidityPercent` (int, 0-100, nullable) and `WindSpeedKmh` (decimal,
  0-400, nullable) to `WeatherForecast`.
- EF Core migration required.
- Update the Minion scheduler to generate realistic random values for these
  fields, informed by the weather profiles from Notebook 04.
- Update the weatheredit-app form with appropriate validation.
- Update the weather-app display table.

**Depends on:** "Add location to WeatherForecast" is not a hard dependency but
the two changes are cleanly batched into one migration.

---

### Minion forecast generation guided by historical profiles — [Plan](plans/plan-profile-guided-minions.md)

**Motivation:** `MinionSchedulerService` currently generates fully random
`TemperatureC` and `Summary` values. `dag_quality_report.py` exists precisely
to measure how unrealistic these values are. Notebook 04 has already produced
`weather_profiles_v1.json` — per-city, per-month temperature statistics and
label probability distributions. The minion scheduler should use these profiles
to generate statistically realistic forecasts.

**Implementation notes:**
- The scheduler is a .NET `BackgroundService`. Options for consuming the profile:
  1. Download the profile JSON from MinIO at startup and cache it in memory,
     refreshing daily.
  2. Expose a read endpoint on a small Python sidecar (or Airflow) that the
     .NET service calls.
  3. Periodically copy the profile to a Postgres table; the .NET service reads it.
- Option 1 is simplest: add MinIO SDK (`Minio` NuGet package), download
  `weather-analytics/profiles/weather_profiles_v1.json` on startup.
- Use the profile's mean and standard deviation to sample temperatures via
  a truncated normal distribution. Use the label probabilities to pick a
  consistent `Summary`.
- The quality score in `dag_quality_report.py` should increase measurably after
  this change, providing a concrete validation signal.

**Depends on:** `weather_profiles_v1.json` in MinIO (produced by Notebook 04).

---

## User-Facing Features

### Historical weather browser in the weather-app — [Plan](plans/plan-historical-weather-browser.md)

**Motivation:** Users can currently only see the current forecast table. The
DuckDB file in MinIO contains the full CDC history of all forecast changes.
A read-only historical view showing forecasts for a past date range would
make the accumulated data accessible to non-technical users.

**Implementation notes:**
- Add a date-range picker to the weather-app (or a new "History" tab).
- New API endpoint: `GET /weather/history?from=YYYY-MM-DD&to=YYYY-MM-DD`
  queries the Postgres `WeatherForecasts` table filtered by date.
- Paginate results: 50 rows per page.
- No new auth requirements — public read access already allowed.

---

### Temperature trend sparklines in the weather-app table — [Plan](plans/plan-temperature-sparklines.md)

**Motivation:** A single-number temperature reading has no context. A small
sparkline chart (7-day trend) next to each forecast gives the viewer
immediate sense of whether the weather is warming or cooling.

**Implementation notes:**
- For each row in the forecast table, fetch the last 7 days of temperature
  readings for the same location (once the location field exists).
- Use a lightweight SVG sparkline library (`ngx-charts` or a custom SVG
  component) — avoid Chart.js for a table cell.
- Cache the trend data in the Angular component for the session to avoid
  N+1 API calls.

**Depends on:** "Add location to WeatherForecast."

---

### Weather alert notifications (in-app and email) — [Plan](plans/plan-weather-alerts.md)

**Motivation:** The platform has no alerting capability. Users who care about
extreme conditions have no way to be notified without polling the UI manually.
Even a simple threshold-based alert (e.g., temperature > 40°C for a location)
would be a meaningful step forward.

**Implementation notes:**
- Alert definitions: `(location, metric, operator, threshold)` stored in a new
  `WeatherAlerts` Postgres table. EF Core migration required.
- Alert evaluation: a new Airflow DAG runs every 15 minutes, queries the latest
  forecast for each location, and checks against all active alert definitions.
- Notification channels:
  - **In-app**: Push a notification event to a Kafka topic; the Angular app
    subscribes via the Electron bridge or a WebSocket. Display a toast.
  - **Email**: Use SMTP (Airflow's built-in email operator) to send a message
    when a threshold is breached.
- Alert deduplication: do not re-notify if the threshold was already breached
  in the previous evaluation window.
- This requires the "Add location to WeatherForecast" idea to be meaningful.

**Depends on:** Location field, EF Core migration, Kafka topic for notifications.

---

### Admin-app: quality score panel — [Plan](plans/plan-admin-quality-panel.md)

**Motivation:** The quality score from `dag_quality_report.py` is invisible to
non-technical users. Adding a "Data Quality" panel to the admin-app with the
current score, a trend indicator, and a link to the raw report in MinIO would
surface this metric without requiring Grafana access.

**Implementation notes:**
- New admin-app card in the "Data Science" category.
- Backend: `GET /api/quality/latest` reads the most recent quality report JSON
  from MinIO and returns the score and run date.
- Display: score as a large number with a color (green >80, amber 50-80, red <50)
  and a small trend arrow (comparing to the previous day's score).

---

### Public API documentation improvements — [Plan](plans/plan-api-docs-improvements.md)

**Motivation:** The API is documented via Scalar (`/scalar/v1`). As new
endpoints are added (history, quality, alerts), keeping the Scalar/OpenAPI
spec accurate and comprehensive reduces integration effort for any future
consumers.

**Implementation notes:**
- Add XML doc comments to all controllers for operation summaries and parameter
  descriptions.
- Add example request/response values to the OpenAPI spec using
  `[SwaggerRequestExample]` or inline `Produces`/`Consumes` attributes.
- Add a `GET /weather/metadata` endpoint that returns the list of valid
  locations and the current label-to-temperature mapping — useful for clients
  building UI dropdowns.

---

## Machine Learning & Forecasting

### Notebook 06: Temperature anomaly detection with Isolation Forest — [Plan](plans/plan-notebook-anomaly-detection.md)

**Motivation:** The quality report uses z-scores for anomaly detection, which
assumes a Gaussian distribution. Isolation Forest is a more robust unsupervised
method for detecting multi-dimensional outliers (temperature + humidity + wind
speed together). Adding it as a Jupyter exploration would validate whether the
simpler z-score approach is adequate.

**Implementation notes:**
- Use `scikit-learn`'s `IsolationForest`.
- Features: `temperature_2m_mean`, `precipitation_sum`, `wind_speed_10m_max`
  from the Open-Meteo historical data.
- Compare the anomalies flagged by Isolation Forest against those flagged by
  the quality report's z-score method.
- Export the trained model to MinIO as a pickle file for potential use in a
  DAG.

---

### DAG to retrain and publish weather profiles monthly — [Plan](plans/plan-dag-retrain-profiles.md)

**Motivation:** `weather_profiles_v1.json` is a static artifact produced by
Notebook 04 and manually uploaded to MinIO. As more historical data is
ingested, the profiles become stale. A monthly retraining DAG would keep
profiles current without manual intervention.

**Implementation notes:**
- Replicate the profile-building logic from Notebook 04 in a Python module
  in `apps/datascience/shared/`.
- DAG schedule: first day of each month at 04:00 UTC (after the nightly
  download has completed).
- Write output to `weather-analytics/profiles/weather_profiles_v{N+1}.json`
  with versioning, and update a `latest` pointer object so consumers always
  read the current version.
- Emit the profile version as a metric to Prometheus.

---

### Jupyter notebook for multi-source data fusion — [Plan](plans/plan-notebook-data-fusion.md)

**Motivation:** The platform now has three data sources (GHCN-Daily, Open-Meteo,
and potentially NWS/ISD). A notebook that joins these sources on `(location,
date)` and resolves conflicts (e.g., GHCN and Open-Meteo may disagree on a
day's high temperature due to station vs. grid-cell averaging) would establish
a canonical "ground truth" dataset for the platform.

**Implementation notes:**
- Notebook 07: load all sources into a single DataFrame aligned on date and
  location.
- Compute pairwise correlation and mean absolute difference between sources.
- Apply a simple ensemble average (equal-weight) as the fused ground truth.
- Write the fused dataset to `weather-analytics/ground-truth/{location}.parquet`.

---

## Testing & CI/CD

### Contract tests for the Kafka Avro schemas — [Plan](plans/plan-kafka-contract-tests.md)

**Motivation:** The Debezium CDC pipeline uses Avro schemas registered in the
Schema Registry. If a developer adds a non-nullable column to `WeatherForecasts`
without updating the Avro schema, the CDC pipeline breaks silently. Contract
tests would catch this.

**Implementation notes:**
- Use `confluent_kafka` and `fastavro` in a pytest suite under
  `apps/weather-api-tests/`.
- Test that the current EF Core model snapshot is compatible with the
  registered Avro schema (i.e., every non-nullable column has a default or
  null type in the Avro schema).
- Run in CI after the build step and before e2e tests.

---

### Integration test for DAG end-to-end pipeline — [Plan](plans/plan-dag-integration-tests.md)

**Motivation:** The DAGs are currently only tested manually by triggering them
in Airflow. An automated integration test that runs the full pipeline (ingest ->
DuckDB upsert -> quality report) against a MinIO test bucket would catch
regressions early.

**Implementation notes:**
- Use `pytest` with a test Airflow environment (the same SQLite/SequentialExecutor
  setup, but pointed at a test MinIO bucket).
- Fixture: pre-populate a test MinIO bucket with a small sample of GHCN and
  Open-Meteo data.
- Assert: after running the DAG tasks directly (call the Python functions, not
  Airflow scheduler), the DuckDB table contains the expected rows and the
  quality report JSON is well-formed.
- Add to GitHub Actions CI.

---

### Performance benchmark for the Weather API — [Plan](plans/plan-api-performance-benchmark.md)

**Motivation:** There are no baseline performance numbers for the REST API.
Without them, it is impossible to know whether a future change has regressed
throughput or latency.

**Implementation notes:**
- Use `k6` or `wrk` to run a 30-second load test against `GET /weather` and
  `POST /weather` in CI.
- Define acceptance thresholds: p95 response time < 200ms at 50 concurrent
  users for GET; < 500ms for POST.
- Run against a populated test database (100k rows) to make the benchmark
  meaningful.
- Store baseline results as a JSON artifact in GitHub Actions; compare on
  each run and fail if regression > 20%.

---

## Future Platform Directions

### Multi-location forecast comparison view — [Plan](plans/plan-multi-location-map.md)

**Motivation:** The platform monitors 10 cities across the globe. A side-by-side
comparison of current conditions across all locations — displayed as a world map
or a sortable grid — would be the natural evolution of the single-location
forecast table.

**Implementation notes:**
- New remote Angular app (`forecast-map-app`) or a new route in the existing
  `weather-app`.
- Use `Leaflet.js` or `MapLibre GL` for the map view (both are MIT-licensed).
  Angular wrapper: `ngx-leaflet`.
- Each city represented as a map marker with a popup showing current
  temperature, condition emoji, and wind speed.
- Data source: `GET /weather?location=all&date=today` or a dedicated
  `/weather/summary` endpoint.

**Depends on:** "Add location to WeatherForecast."

---

### Webhook / outbound event publishing — [Plan](plans/plan-webhook-publishing.md)

**Motivation:** External systems (home automation, scheduling tools, custom
dashboards) may want to subscribe to forecast changes without polling the API.
Publishing Kafka CDC events to an outbound webhook endpoint would make the
platform an event source for downstream integrations.

**Implementation notes:**
- A new Airflow DAG or small Go/Python service consumes from the
  `weather.public.WeatherForecasts` Kafka topic and POSTs a simplified JSON
  payload to a configurable list of webhook URLs stored in Postgres.
- Include a shared secret in the `X-Weather-Signature` header (HMAC-SHA256)
  for receiver authentication.
- Retry on failure with exponential backoff; dead-letter after 3 failures.

---

### Backup and restore runbook for Postgres and MinIO — [Plan](plans/plan-backup-restore-runbook.md)

**Motivation:** All persistent state lives in two places: the Postgres volume
and the MinIO volume. There is no documented backup procedure. A volume
corruption event would lose all forecasts, Kratos identities, Airflow metadata,
and ingested weather data.

**Implementation notes:**
- Postgres: `pg_dump` to a compressed file, uploaded to an off-host location
  (another MinIO bucket, an S3-compatible remote, or simply a host directory).
  Schedule as a daily cron job or Airflow DAG.
- MinIO: `mc mirror` to a remote bucket or local directory.
- Document the restore procedure in `RUN.md`: how to recreate the Postgres
  schema, reload data, and re-register Debezium connectors.
- Test the restore procedure in CI on a schedule (monthly) by running it
  against a throwaway database.
