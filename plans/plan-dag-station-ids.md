# Plan: DAG to List/Validate Weather Underground Station IDs

## Goal

Create an Airflow DAG that discovers, validates, and maintains a list of active Weather Underground Personal Weather Station (PWS) IDs near each target city, persisting the curated index to MinIO for consumption by the Weather Underground scraping DAG.

## Current State

- **No station tracking exists.** The codebase has no Weather Underground integration yet.
- **Target cities** are defined in `apps/datascience/shared/weather_sources.py`:
  - `OPEN_METEO_LOCATIONS`: New York, London, Tokyo, Melbourne, Singapore (lat/lon pairs).
  - `GHCN_STATIONS`: New York, LA, London, Tokyo, Melbourne (station IDs).
- **MinIO helpers** in `apps/datascience/shared/minio_helper.py` support JSON upload via `put_object()` and download via `get_object()`.
- **Existing DAG patterns** in `dag_download_weather.py` show the standard structure: `_DEFAULT_ARGS`, `ShortCircuitOperator` for skip logic, `PythonOperator` tasks, and a terminal `all_done` task.
- **Containerfile:** `requests` is already installed.

## Implementation Steps

### 1. Research the Weather Underground station discovery endpoint

The Weather Company (IBM) provides station search APIs. Investigate these endpoints:

- `https://api.weather.com/v3/location/near?geocode={lat},{lon}&range=25&units=m&format=json` -- Nearby PWS stations.
- `https://api.weather.com/v3/location/search?query={city}&language=en-US&format=json` -- City-based station search.
- `https://www.wunderground.com/cgi-bin/findweather/getForecast?query={lat},{lon}` -- Legacy endpoint that lists nearby stations.

Some of these may require an API key. Document which endpoints work without authentication and which require a key.

**Fallback approach:** If no API-based discovery works, manually curate an initial station list by:
1. Visiting `https://www.wunderground.com/dashboard/pws/{city}` in a browser.
2. Noting 3-5 active station IDs per US city.
3. Hardcoding them in the helper module.
4. Using this DAG purely for validation/staleness checking rather than discovery.

### 2. Create the station discovery helper

Create `apps/datascience/shared/wu_station_discovery.py`:

```python
SEARCH_RADIUS_KM = 25  # Search radius around each city center
MAX_STATIONS_PER_CITY = 5  # Keep top N closest/most-active stations
STALENESS_THRESHOLD_DAYS = 7  # Station must have reported in last N days

# Cities to search for PWS stations (US focus for Weather Underground)
TARGET_CITIES = [
    {"name": "new_york", "lat": 40.7128, "lon": -74.0060},
    {"name": "los_angeles", "lat": 33.9425, "lon": -118.4081},
]
```

Functions:
- `discover_stations(lat, lon, radius_km=25)` -- Query the discovery endpoint for nearby stations. Returns list of `{"station_id": str, "name": str, "lat": float, "lon": float, "elevation_m": float}` dicts.
- `validate_station(station_id)` -- Check if the station has reported data recently by requesting its latest observation. Returns `{"station_id": str, "is_active": bool, "last_observation_date": str}`.
- `build_station_index(cities, max_per_city=5)` -- For each city, discover stations, validate them, and return the top N active stations sorted by proximity. Returns a dict keyed by city name.

### 3. Create the DAG file

Create `apps/datascience/airflow/dags/dag_wu_station_ids.py`:

**Schedule:** Weekly on Sunday at 00:00 UTC. Station lists are stable -- weekly validation is sufficient.

**DAG structure:**
```
discover_stations  -->  validate_stations  -->  build_and_upload_index  -->  done
```

Three tasks, executed linearly:

1. **discover_stations**: For each target city, call the discovery endpoint. Push the raw discovery results to XCom as JSON.

2. **validate_stations**: Pull discovery results from XCom. For each discovered station, check if it has reported in the last 7 days. Push the validated list to XCom.

3. **build_and_upload_index**: Pull validated stations from XCom. Build the final index JSON:
   ```json
   {
     "generated_at": "2026-03-28T00:00:00Z",
     "version": 1,
     "cities": {
       "new_york": {
         "stations": [
           {
             "station_id": "KNYNEWYO123",
             "name": "Brooklyn Heights",
             "lat": 40.6945,
             "lon": -73.9936,
             "distance_km": 2.3,
             "last_observation": "2026-03-27",
             "is_active": true
           }
         ]
       }
     }
   }
   ```
   Upload to `weather-raw/wunderground/station_index.json` in MinIO.

**No ShortCircuit needed:** This DAG always runs to revalidate freshness. It overwrites the previous index each time.

### 4. Staleness detection and alerting

In the `validate_stations` task:
- Log a warning for any station that was previously in the index but is now inactive.
- Log the total active/inactive/new station counts for observability.
- If zero active stations are found for a city, log an error (this may indicate the discovery API has changed).

### 5. Rate limiting for discovery/validation requests

- Add a 2-second delay between consecutive station validation requests.
- Discovery requests (one per city) have a 5-second delay between them.
- Total expected runtime: ~2 cities x 5 stations x 2 seconds = ~25 seconds for validation, plus discovery time. Well within the 20-minute execution timeout.

### 6. Output format specification

The station index JSON file serves as the contract between this DAG and the Weather Underground scraping DAG (`plan-dag-weather-underground.md`). Define the schema clearly:

```json
{
  "generated_at": "ISO 8601 timestamp",
  "version": 1,
  "staleness_threshold_days": 7,
  "cities": {
    "<city_name>": {
      "stations": [
        {
          "station_id": "string -- PWS ID like KNYNEWYO123",
          "name": "string -- human-readable station name",
          "lat": "float -- WGS-84 latitude",
          "lon": "float -- WGS-84 longitude",
          "distance_km": "float -- distance from city center",
          "last_observation": "string -- ISO date of last data report",
          "is_active": "bool -- true if last_observation within staleness threshold"
        }
      ]
    }
  }
}
```

## Files to Create/Modify

- **Create:** `apps/datascience/shared/wu_station_discovery.py` -- Station discovery and validation functions
- **Create:** `apps/datascience/airflow/dags/dag_wu_station_ids.py` -- Airflow DAG

## Testing

1. **Discovery endpoint test:** Call `discover_stations(40.7128, -74.0060)` from a Python shell. Verify it returns a non-empty list of station dicts with `station_id`, `lat`, `lon` fields.
2. **Validation test:** Call `validate_station("KNYNEWYO123")` (use a known active station). Verify `is_active` is True and `last_observation_date` is recent.
3. **Stale station test:** Call `validate_station("XYZINVALID999")`. Verify it returns `is_active: false` without raising an exception.
4. **Full index build:** Call `build_station_index(TARGET_CITIES)`. Verify the output dict has entries for each city with <= `MAX_STATIONS_PER_CITY` stations.
5. **DAG trigger:** Trigger `dag_wu_station_ids` manually in Airflow UI. Verify:
   - `weather-raw/wunderground/station_index.json` appears in MinIO.
   - The JSON is well-formed and matches the schema above.
6. **Repeated trigger:** Run again the following week. Verify the index is updated (check `generated_at` timestamp).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Discovery API requires authentication or has been deprecated | Fallback: manually curate initial station list; use this DAG only for validation |
| Discovery API returns too many stations | Limit to `MAX_STATIONS_PER_CITY` (5); sort by proximity and recency |
| All stations for a city are inactive | Log an error; keep the previous index in MinIO (do not overwrite with an empty city) |
| Rate limiting on validation requests | 2-second delay between requests; only validate ~10 stations total per run |
| Station IDs change format | Validate format (e.g., US stations match `K[A-Z]{2}[A-Z0-9]+` pattern) before including |

## Dependencies

- **No hard dependencies.** This DAG is a prerequisite for `plan-dag-weather-underground.md`, not the other way around.
- **Benefits from:** Nothing -- this is a standalone supporting DAG.
- **Required by:** `plan-dag-weather-underground.md` (the scraping DAG reads the station index from MinIO).

## Estimated Complexity

**Small** -- The DAG is simple (3 linear tasks). The main uncertainty is which discovery API endpoint works. If manual curation is needed as a fallback, the DAG reduces to a pure validation job, which is even simpler.
