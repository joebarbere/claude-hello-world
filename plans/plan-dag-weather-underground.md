# Plan: DAG to Web Scrape Weather Underground Data

## Goal

Create an Airflow DAG that scrapes daily weather observations from Weather Underground Personal Weather Stations (PWS), storing raw responses in MinIO for hyper-local neighborhood-level data that supplements official station records.

## Current State

- **Existing DAGs:** `dag_download_weather.py` fetches GHCN-Daily and Open-Meteo data using well-documented public APIs. No scraping-based ingestion exists yet.
- **Shared helpers:** `minio_helper.py` provides all needed upload/download utilities. `weather_sources.py` defines the five target cities.
- **Station IDs:** No Weather Underground station IDs are currently tracked. The "DAG to list valid Weather Underground station IDs" (see `plan-dag-station-ids.md`) must produce a station index before this DAG can run.
- **Containerfile:** `apps/datascience/airflow/Containerfile` has `requests` installed. No HTML parsing library (e.g., `beautifulsoup4`) is currently included.
- **Airflow runtime:** SQLite + SequentialExecutor -- tasks run serially, which actually helps with rate limiting since only one request runs at a time.

## Implementation Steps

### 1. Investigate the Weather Underground JSON endpoint

Before building HTML scraping, verify whether the unofficial JSON API is still accessible:

```
GET https://api.weather.com/v2/pws/dailysummary/7day
    ?stationId=KNYNEWYO123
    &format=json
    &units=m
    &apiKey=...
```

Weather Underground was acquired by The Weather Company (IBM). The PWS API historically required a free API key obtained by registering a station or via a developer portal. Check:
- Whether `api.weather.com/v2/pws/` endpoints still respond.
- Whether a free API key is obtainable.
- What rate limits apply.

If the JSON API is available, prefer it over HTML scraping (more stable, structured data). If not, fall back to HTML scraping of the `/history/daily` page.

### 2. Create the scraping helper module

Create `apps/datascience/shared/wunderground_helper.py`:

```python
WU_HISTORY_URL = "https://www.wunderground.com/dashboard/pws/{station_id}/table/{date}/{date}/daily"
# Alternative JSON endpoint (if available):
WU_API_URL = "https://api.weather.com/v2/pws/dailysummary/7day"

USER_AGENT = "Mozilla/5.0 (weather-research-platform; educational use)"
```

Functions:
- `load_station_index(minio_client)` -- Reads `weather-raw/wunderground/station_index.json` from MinIO. Returns a list of `{"station_id": str, "city": str, "lat": float, "lon": float, "last_seen": str}` dicts. Raises an error if the index does not exist (hard dependency on the station-IDs DAG).
- `scrape_daily_observation(station_id, date, output_dir="/tmp")` -- Fetches the daily history page for one station on one date. Extracts: high/low temperature, avg temperature, humidity, dew point, pressure, wind speed, precipitation, and condition text. Writes raw response (HTML or JSON depending on endpoint) to `{output_dir}/wu_{station_id}_{date}.json`. Returns local path.
- `extract_weather_data(raw_html)` -- If HTML scraping: parse the history table using BeautifulSoup. Returns a dict of extracted fields.

### 3. Implement politeness controls

This is the highest-risk DAG in terms of being blocked. Implement:

- **Jitter between requests:** Random delay of 5-30 seconds between station fetches using `time.sleep(random.uniform(5, 30))`. Call this in the task callable before each HTTP request.
- **Polite User-Agent:** Include a descriptive, non-deceptive User-Agent string.
- **robots.txt compliance:** Check `https://www.wunderground.com/robots.txt` for disallowed paths. If `/history/` or `/dashboard/` is disallowed, document this and proceed only with the API endpoint.
- **One request per station per day:** The ShortCircuit check ensures no redundant fetches.
- **Session headers:** Use a `requests.Session` with realistic headers (Accept, Accept-Language, Accept-Encoding) to reduce blocking risk.

### 4. Create the DAG file

Create `apps/datascience/airflow/dags/dag_scrape_wunderground.py`:

**Schedule:** Daily at 05:00 UTC (after all API-based ingestion DAGs complete).

**DAG structure:**
```
load_station_index  -->  for each station:
                           check_wu_{station}  -->  scrape_wu_{station}  -->  upload_wu_{station}
                                                                              |
all uploads  ---------------------------------------------------------------->  all_done
```

The `load_station_index` task reads the station list from MinIO (produced by the station-IDs DAG). Downstream tasks are generated dynamically based on the station list. Since the station list is read at DAG parse time (not runtime) for static task generation, either:
- Parse the station index at module level with a try/except (return empty list on failure, DAG has no tasks), or
- Use a fixed list of station IDs that is updated manually, with the station-IDs DAG serving as a validation/staleness check.

**Preferred approach:** Use a fixed list in the helper module (e.g., 2-3 stations per US city) and have the station-IDs DAG validate/update it. This avoids runtime DAG topology changes which are fragile.

**MinIO storage layout:**
```
weather-raw/
  wunderground/
    station_index.json                            -- produced by station-IDs DAG
    {station_id}/
      {YYYY-MM-DD}.json                           -- daily observation for one station
    metadata/
      station_city_mapping.json                   -- which stations map to which cities
```

### 5. Update the Containerfile

Add `beautifulsoup4` and `lxml` to the pip install in `apps/datascience/airflow/Containerfile`:

```dockerfile
RUN pip install --no-cache-dir \
        ...existing packages... \
        beautifulsoup4 \
        lxml
```

Only needed if using HTML scraping. Skip if the JSON API is available.

### 6. Station-to-city mapping

Create `apps/datascience/shared/wunderground_stations.py` (or include in `wunderground_helper.py`):

```python
# Manually curated PWS stations near the target cities.
# Validated by the station-IDs DAG (plan-dag-station-ids.md).
WU_STATIONS = {
    "new_york": ["KNYNEWYO123", "KNYNEWYO456"],
    "los_angeles": ["KCALOSAN789", "KCALOSAN012"],
}
```

Only US cities are relevant (Weather Underground PWS coverage is primarily US). London, Tokyo, Melbourne, and Singapore stations may exist but with much lower density.

### 7. Error handling and circuit breaker

Since scraping is fragile:
- If 3 consecutive stations fail with HTTP 403 or 429, mark the remaining tasks as failed and log a warning that Weather Underground may be blocking requests.
- Store the last successful scrape date per station in a MinIO metadata file. If a station has not returned data in 30 days, flag it as potentially defunct.

## Files to Create/Modify

- **Create:** `apps/datascience/shared/wunderground_helper.py` -- Scraping/API client functions, station list
- **Create:** `apps/datascience/airflow/dags/dag_scrape_wunderground.py` -- Airflow DAG
- **Modify:** `apps/datascience/airflow/Containerfile` -- add `beautifulsoup4` and `lxml` (if HTML scraping)

## Testing

1. **Manual scrape test:** Run `scrape_daily_observation("KNYNEWYO123", "2025-01-15", "/tmp")` from a Python shell. Inspect the output JSON for completeness.
2. **Robots.txt check:** Fetch `https://www.wunderground.com/robots.txt` and verify the target paths are not disallowed.
3. **Rate limit test:** Scrape 3 stations in sequence with jitter. Verify no 403/429 responses.
4. **DAG trigger:** Trigger `dag_scrape_wunderground` manually. Verify JSON files appear in MinIO.
5. **Missing station index:** Remove the station index from MinIO and trigger the DAG. Verify it fails gracefully with a clear error message.
6. **Idempotency:** Re-trigger -- all stations should be skipped by ShortCircuit.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Weather Underground actively blocks scrapers | Use JSON API if available; polite User-Agent; 5-30s jitter; limit to 2-3 stations per city |
| HTML page structure changes without notice | Store raw HTML alongside parsed JSON; parser failures trigger alerts rather than silent data loss |
| Station goes offline or is decommissioned | Station-IDs DAG validates staleness weekly; defunct stations are skipped |
| Legal/ToS concerns with scraping | Check ToS before implementation; this is for educational/research use on a local dev platform |
| Highest maintenance burden of all ingestion sources | Document this explicitly; treat as "nice to have" and prioritize API-based sources |
| BeautifulSoup adds to container image size | Minimal impact (~2 MB); can be skipped if JSON API works |

## Dependencies

- **Hard dependency:** `plan-dag-station-ids.md` -- the station-IDs DAG must produce `weather-raw/wunderground/station_index.json` before this DAG can validate stations.
- **Soft dependency:** The fixed station list in the helper module allows the DAG to run even if the station-IDs DAG has not been implemented yet, but stations will not be validated.
- **Benefits from:** "Use Postgres for Airflow metadata" (LocalExecutor would not help here due to intentional serial execution for rate limiting).

## Estimated Complexity

**Large** -- Scraping is inherently fragile and requires ongoing maintenance. The JSON API investigation, HTML parsing, rate limiting, error handling, and station management all add complexity beyond the straightforward API-based DAGs. This should be the last ingestion DAG implemented.
