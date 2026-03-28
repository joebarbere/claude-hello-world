# Plan: DAG to Fetch Open-Meteo Forecast Data

## Goal

Create an Airflow DAG that fetches 7-day weather forecasts from the Open-Meteo Forecast API for all configured locations, storing versioned forecast snapshots in MinIO to enable forecast skill evaluation (comparing predictions against actuals).

## Current State

- **Existing Open-Meteo integration:** `apps/datascience/shared/weather_sources.py` defines:
  - `OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"` -- the historical/archive API.
  - `OPEN_METEO_LOCATIONS` -- 5 cities with lat/lon: New York, London, Tokyo, Melbourne, Singapore.
  - `OPEN_METEO_DAILY_VARIABLES` -- 9 daily variables (temperature max/min/mean, precipitation, rain, snowfall, wind speed, wind gusts, shortwave radiation).
  - `download_open_meteo()` -- downloads historical data for a date range, returns CSV path.
- **Existing DAG:** `dag_download_weather.py` uses the archive API to fetch 2020-2024 historical data. Schedule: daily at 02:00 UTC.
- **MinIO layout:** Historical data stored at `weather-raw/open-meteo/{label}.csv` (one file per location, replaced daily).
- **Airflow runtime:** SQLite + SequentialExecutor. Container has `requests` and `pandas` installed.
- **No forecast data exists yet.** Only historical/archive data is ingested.

## Implementation Steps

### 1. Understand the API difference

The Open-Meteo **Forecast API** is separate from the Archive API:

| | Archive API (existing) | Forecast API (new) |
|---|---|---|
| URL | `archive-api.open-meteo.com/v1/archive` | `api.open-meteo.com/v1/forecast` |
| Data | Historical actuals (1940-present) | Model forecasts (today + 7 days) |
| Parameters | `start_date`, `end_date` required | `forecast_days` (default 7) |
| API key | Not required | Not required |
| Rate limit | None documented | None documented (fair use) |
| Update frequency | Daily (previous day finalized) | Every 6 hours (00, 06, 12, 18 UTC model runs) |

The same `daily` variable names work on both endpoints. The response format is identical (JSON with `daily.time[]` and parallel arrays for each variable).

### 2. Add forecast download function to weather_sources.py

Extend `apps/datascience/shared/weather_sources.py` with a new function:

```python
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

def download_open_meteo_forecast(
    latitude: float,
    longitude: float,
    location_label: str,
    forecast_days: int = 7,
    daily_variables: list = None,
    output_dir: str = "/tmp",
    timeout_seconds: int = 60,
) -> str:
    """
    Download the current 7-day forecast from Open-Meteo for one location.

    Unlike download_open_meteo() which fetches historical data with
    start_date/end_date, this function fetches the forward-looking forecast.

    Returns the path to a CSV file written to output_dir.
    """
```

Key differences from `download_open_meteo()`:
- Uses `OPEN_METEO_FORECAST_URL` instead of `OPEN_METEO_URL`.
- Passes `forecast_days=7` instead of `start_date`/`end_date`.
- Adds a `fetched_at` column (ISO timestamp) to record when the forecast was retrieved -- critical for forecast skill evaluation.
- Adds a `model_run` column if available from the API response metadata.

### 3. Design versioned storage for forecast skill evaluation

This is the key differentiator from the historical DAG. Forecasts must be versioned by retrieval date so we can later compare:
- "What did Open-Meteo predict on March 1 for March 5?" vs. "What actually happened on March 5?"

**MinIO storage layout:**
```
weather-raw/
  open-meteo-forecast/
    {location}/
      {YYYY-MM-DD}.json    -- forecast retrieved on this date
```

Each file contains:
```json
{
  "fetched_at": "2026-03-28T01:00:00Z",
  "location": "new_york",
  "latitude": 40.7128,
  "longitude": -74.006,
  "forecast_days": 7,
  "daily": {
    "time": ["2026-03-28", "2026-03-29", ..., "2026-04-03"],
    "temperature_2m_max": [12.3, 14.1, ...],
    "temperature_2m_min": [5.2, 6.8, ...],
    ...
  }
}
```

Store the full API response as JSON (not CSV) to preserve the complete forecast snapshot including metadata. This differs from the historical DAG which stores CSV because the archive data is large and tabular. Forecast data is small (7 rows per location) and the JSON preserves the fetch timestamp and structure.

### 4. Create the DAG file

Create `apps/datascience/airflow/dags/dag_download_open_meteo_forecast.py`:

**Schedule:** Daily at 01:00 UTC. This is before the historical download at 02:00 UTC, ensuring the forecast is captured from the latest model run (which typically updates around 00:00 UTC).

**DAG structure (following existing patterns):**
```
for each location in OPEN_METEO_LOCATIONS:
  check_forecast_{label}  -->  download_forecast_{label}  -->  upload_forecast_{label}
                                                                |
all uploads  --------------------------------------------------->  all_done
```

**ShortCircuit logic:** Check if `open-meteo-forecast/{label}/{today}.json` exists in MinIO. If it does, skip the download. This prevents duplicate fetches on manual re-runs while ensuring one forecast snapshot per day.

**Task implementation:**

```python
def _download_and_upload_forecast(latitude, longitude, label, **context):
    """Download forecast and upload as JSON to MinIO."""
    # Use the new download_open_meteo_forecast() function
    local_path = download_open_meteo_forecast(
        latitude=latitude,
        longitude=longitude,
        location_label=label,
        output_dir="/tmp",
    )

    today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    object_name = f"open-meteo-forecast/{label}/{today}.json"

    client = get_client()
    upload_file(
        client,
        bucket="weather-raw",
        object_name=object_name,
        file_path=local_path,
        content_type="application/json",
    )
    os.remove(local_path)
```

### 5. Store as JSON instead of CSV

Unlike the historical DAG which stores CSV, store forecasts as JSON because:
1. Each forecast is small (7 rows) -- CSV overhead is unnecessary.
2. JSON preserves the `fetched_at` metadata naturally.
3. Forecast skill evaluation will load multiple days' forecasts and pivot them -- JSON is easier to work with for this use case.

Modify `download_open_meteo_forecast()` to write JSON (not CSV):

```python
import json

output_path = os.path.join(output_dir, f"open_meteo_forecast_{location_label}.json")
payload = {
    "fetched_at": datetime.now(tz=timezone.utc).isoformat(),
    "location": location_label,
    "latitude": latitude,
    "longitude": longitude,
    "forecast_days": forecast_days,
    "daily": data["daily"],  # raw API response
}
with open(output_path, "w") as fh:
    json.dump(payload, fh, indent=2)
```

### 6. Forecast skill evaluation support

The versioned storage enables future analysis (Notebook 05 from IDEAS.md):
- Load all forecast JSONs for a location: `open-meteo-forecast/new_york/2026-03-01.json` through `...2026-03-28.json`.
- For each forecast, extract the predicted temperature for day+1 through day+7.
- Compare against the actual temperature from the Open-Meteo archive or GHCN data.
- Compute MAE and RMSE by lead time.

This DAG does not perform the evaluation -- it only collects the data. The evaluation belongs in a notebook or a separate DAG.

### 7. No Containerfile changes needed

The forecast API uses the same `requests` + `pandas` libraries already installed. JSON writing uses only stdlib.

## Files to Create/Modify

- **Modify:** `apps/datascience/shared/weather_sources.py` -- add `OPEN_METEO_FORECAST_URL` constant and `download_open_meteo_forecast()` function
- **Create:** `apps/datascience/airflow/dags/dag_download_open_meteo_forecast.py` -- Airflow DAG

## Testing

1. **API response test:** Call the forecast endpoint directly:
   ```python
   import requests
   resp = requests.get("https://api.open-meteo.com/v1/forecast", params={
       "latitude": 40.7128, "longitude": -74.006,
       "daily": ["temperature_2m_max", "temperature_2m_min"],
       "timezone": "UTC", "forecast_days": 7,
   })
   data = resp.json()
   assert "daily" in data
   assert len(data["daily"]["time"]) == 7
   ```
2. **Helper function test:** Call `download_open_meteo_forecast(40.7128, -74.006, "new_york")` and verify the output JSON contains `fetched_at`, `daily.time` (7 entries), and all requested variables.
3. **DAG trigger:** Trigger `dag_download_open_meteo_forecast` manually. Verify:
   - JSON files appear at `weather-raw/open-meteo-forecast/{label}/{today}.json` for all 5 locations.
   - Each JSON has 7 forecast days.
4. **Idempotency:** Re-trigger the DAG. All tasks should be skipped by ShortCircuit.
5. **Multi-day accumulation:** After running for 3+ days, verify that each location directory contains one JSON per day (e.g., `2026-03-26.json`, `2026-03-27.json`, `2026-03-28.json`).
6. **Compare with archive:** Fetch today's forecast and compare the "today" row against yesterday's archive data for the same location. Values should be similar (not identical, since forecast vs. reanalysis differ).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Open-Meteo changes the forecast API response format | Store full JSON response; version the helper function; the archive API has been stable for years |
| Forecast model run timing means stale data at 01:00 UTC | The 00Z model run is typically available by 01:00 UTC; if not, the response will use the 18Z run from the previous day (still valid) |
| Storage accumulation (one file per location per day) | Each JSON is ~2-5 KB; 5 locations x 365 days = ~9 MB/year -- negligible |
| API downtime or rate limiting | Retry once after 5 minutes (existing `_DEFAULT_ARGS`); Open-Meteo has had excellent uptime |
| Forecast data is confused with historical actuals in downstream analysis | Clear separation via MinIO path prefix (`open-meteo-forecast/` vs `open-meteo/`) and the `fetched_at` field |

## Dependencies

- **No hard dependencies.** The Open-Meteo Forecast API is free and requires no setup.
- **Shares config with:** `dag_download_weather.py` -- reuses `OPEN_METEO_LOCATIONS` and `OPEN_METEO_DAILY_VARIABLES` from `weather_sources.py`.
- **Feeds into:** "Notebook 05: Forecast skill evaluation" (the primary consumer of versioned forecast data).
- **Benefits from:** "DAG to validate ingested weather data against climatological norms" (could validate forecasts against bounds too).

## Estimated Complexity

**Small** -- The Open-Meteo Forecast API has the same interface as the Archive API already integrated. The new function is a minor variation of `download_open_meteo()`. The DAG structure is a direct copy of the pattern in `dag_download_weather.py`. The main new design element is the versioned JSON storage, which is straightforward.
