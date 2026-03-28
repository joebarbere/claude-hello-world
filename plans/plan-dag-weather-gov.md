# Plan: DAG to Collect Weather Data from weather.gov (NWS API)

## Goal

Create an Airflow DAG that fetches official US weather forecasts and current observations from the National Weather Service API (`api.weather.gov`) for all US locations in the existing station list, storing results as JSON in MinIO.

## Current State

- **Existing DAGs:** Three DAGs exist in `apps/datascience/airflow/dags/`:
  - `dag_download_weather.py` -- ingests GHCN-Daily CSVs and Open-Meteo historical data into MinIO bucket `weather-raw`.
  - `dag_kafka_cdc_to_duckdb.py` -- consumes Kafka CDC events into DuckDB.
  - `dag_quality_report.py` -- generates daily quality scores.
- **Shared helpers:** `apps/datascience/shared/minio_helper.py` provides `get_client()`, `object_exists()`, `upload_file()`, `ensure_bucket()`. `apps/datascience/shared/weather_sources.py` defines `GHCN_STATIONS` and `OPEN_METEO_LOCATIONS` with five cities (New York, LA, London, Tokyo, Melbourne, Singapore).
- **US locations available:** New York (40.7128, -74.0060) and Los Angeles (inferred from `USW00023174` / LAX) are the two US locations already configured.
- **MinIO layout:** Raw data goes into `weather-raw/{source}/{identifier}.csv`. No NWS data exists yet.
- **Airflow runtime:** SQLite + SequentialExecutor, all tasks run serially. Container built from `apps/datascience/airflow/Containerfile` with `requests` already installed.

## Implementation Steps

### 1. Create the NWS helper module

Create `apps/datascience/shared/nws_helper.py` following the same contract as `weather_sources.py` (functions return local file paths).

Key design:

```python
NWS_BASE_URL = "https://api.weather.gov"
NWS_USER_AGENT = "(weather-platform, contact@example.com)"  # Required by NWS API

# US locations from OPEN_METEO_LOCATIONS
NWS_LOCATIONS = [
    (40.7128, -74.0060, "new_york"),
    (33.9425, -118.4081, "los_angeles"),
]
```

Functions to implement:

- `get_nws_point_metadata(lat, lon, cache_dir="/tmp")` -- Calls `GET /points/{lat},{lon}`. Returns dict with `forecastHourly`, `forecast`, and `observationStations` URLs. Cache the response to avoid redundant lookups (NWS point metadata is stable).
- `download_nws_hourly_forecast(lat, lon, label, output_dir="/tmp")` -- Uses the point metadata to fetch the hourly forecast grid. Writes JSON to `{output_dir}/nws_forecast_{label}_{date}.json`. Returns local path.
- `download_nws_current_observation(lat, lon, label, output_dir="/tmp")` -- Finds the nearest observation station from point metadata, then calls `GET /stations/{stationId}/observations/latest`. Writes JSON. Returns local path.

All requests must include:
- `User-Agent` header with application name and contact email (NWS requirement).
- `Accept: application/geo+json` header.
- Timeout of 30 seconds.

### 2. Add rate limiting

The NWS API has no formal rate limit documentation but recommends responsible use. Implement:
- A 1-second sleep between consecutive API calls within the same task.
- Retry with exponential backoff (handled by Airflow's `retries` + `retry_delay` defaults).

### 3. Create the DAG file

Create `apps/datascience/airflow/dags/dag_download_nws.py`:

**Schedule:** Two task groups with different cadences, both in a single DAG:
- Hourly forecasts: daily at 03:00 UTC (after the existing download DAG at 02:00).
- Current observations: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC). Since Airflow SequentialExecutor limits us to one schedule per DAG, use a single daily schedule (03:00 UTC) and fetch the latest observation at that time. Hourly observation collection can be added later when LocalExecutor is available.

**DAG structure (mimicking existing patterns):**
```
check_nws_{location}  -->  fetch_nws_forecast_{location}  -->  upload_nws_forecast_{location}  -\
                                                                                                  +--> all_done
check_nws_obs_{location}  -->  fetch_nws_observation_{location}  -->  upload_nws_obs_{location}  -/
```

**MinIO storage layout:**
```
weather-raw/
  nws/
    {location}/
      forecast/{YYYY-MM-DD}.json     -- hourly forecast grid for that day
      observation/{YYYY-MM-DD}.json  -- latest observation snapshot
    point_metadata/
      {location}.json                -- cached point metadata (rarely changes)
```

Use `ShortCircuitOperator` with `_check_minio_object()` pattern from `dag_download_weather.py` to skip if today's file already exists.

### 4. Handle NWS API response format

NWS returns GeoJSON. Key fields to preserve:
- Forecast: `properties.periods[]` array with `temperature`, `temperatureUnit`, `windSpeed`, `windDirection`, `shortForecast`, `detailedForecast`, `startTime`, `endTime`.
- Observation: `properties.temperature.value` (Celsius), `properties.windSpeed.value`, `properties.relativeHumidity.value`, `properties.barometricPressure.value`.

Store the full JSON response (not just extracted fields) to preserve data for future analysis. Temperature conversion (F to C) can happen at query time.

### 5. Update the Containerfile (if needed)

No changes needed -- `requests` is already installed in the Airflow Containerfile.

### 6. Add NWS locations to a shared config

Either add to `weather_sources.py` as `NWS_LOCATIONS` or import from `nws_helper.py`. Prefer the latter to keep source-specific config in source-specific modules.

## Files to Create/Modify

- **Create:** `apps/datascience/shared/nws_helper.py` -- NWS API client functions
- **Create:** `apps/datascience/airflow/dags/dag_download_nws.py` -- Airflow DAG
- **Modify:** `apps/datascience/shared/weather_sources.py` -- optionally add `US_LOCATIONS` constant for reuse across NWS and existing sources

## Testing

1. **Unit test the helper:** Call `get_nws_point_metadata(40.7128, -74.0060)` from a Python shell and verify the response contains `forecastHourly` and `observationStations` URLs.
2. **Manual DAG trigger:** In Airflow UI, trigger `dag_download_nws` manually. Verify:
   - Point metadata cached in MinIO under `nws/point_metadata/new_york.json`.
   - Forecast JSON appears at `nws/new_york/forecast/{today}.json`.
   - Observation JSON appears at `nws/new_york/observation/{today}.json`.
3. **MinIO inspection:** Use `mc ls local/weather-raw/nws/` to verify the object tree.
4. **Idempotency:** Trigger the DAG a second time -- all tasks should be skipped by the ShortCircuit check.
5. **Error handling:** Temporarily set an invalid lat/lon and verify the task fails with a clear error and retries once.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| NWS API only covers US locations (2 of 5 cities) | Document this limitation; non-US cities use Open-Meteo and GHCN exclusively |
| NWS returns 503 during severe weather events (high demand) | Airflow retries (1 retry, 5-min delay) handle transient failures |
| NWS API deprecates endpoints or changes response format | Store full JSON responses so no data is lost; add a version field to the helper module |
| Point metadata URL changes | Cache metadata in MinIO and refresh weekly (add a separate task with a 7-day TTL check) |
| Rate limiting / IP blocking | 1-second delay between calls; polite User-Agent header; only 2 locations means ~6 API calls per run |

## Dependencies

- **None required before this can start.** MinIO bucket structure from `dag_download_weather.py` is already established.
- **Benefits from:** "Use Postgres for Airflow metadata" (enables LocalExecutor for more frequent observation fetches).
- **Feeds into:** "Notebook 05: Forecast skill evaluation" (NWS forecasts vs. actuals), "DAG to validate ingested weather data against climatological norms."

## Estimated Complexity

**Medium** -- New helper module + new DAG file, but the patterns are well established by `dag_download_weather.py` and `weather_sources.py`. The NWS API is well-documented and free. Main effort is handling the GeoJSON response format and caching point metadata.
