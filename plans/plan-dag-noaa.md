# Plan: DAG to Collect NOAA ISD/CDO Data

## Goal

Create an Airflow DAG that downloads hourly surface observations from NOAA's Integrated Surface Database (ISD) for stations aligned with the existing GHCN station list, storing parsed data as Parquet files in MinIO.

## Current State

- **Existing GHCN ingestion:** `dag_download_weather.py` downloads GHCN-Daily CSVs from `https://www.ncei.noaa.gov/pub/data/ghcn/daily/by_station/{station}.csv`. These provide daily-resolution temperature, precipitation, snow, but lack hourly wind, pressure, and humidity data.
- **Station list:** `weather_sources.py` defines `GHCN_STATIONS`:
  ```python
  GHCN_STATIONS = [
      ("USW00094728", "new_york_central_park"),
      ("USW00023174", "los_angeles_lax"),
      ("UKW00035065", "london_heathrow"),
      ("JA000047662", "tokyo"),
      ("ASN00086282", "melbourne"),
  ]
  ```
- **MinIO layout:** Raw data stored in `weather-raw/ghcn/{station_id}.csv` and `weather-raw/open-meteo/{label}.csv`.
- **Shared helpers:** `minio_helper.py` has `upload_file()`, `upload_dataframe()` (supports Parquet), `read_parquet()`, and `ensure_bucket()`.
- **Containerfile:** Already includes `pandas`, `pyarrow`, and `requests`.

## Implementation Steps

### 1. Map GHCN station IDs to ISD station IDs

GHCN and ISD use different station identifier formats. The mapping is available in NOAA's station inventory files:
- `https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv` -- master ISD station list with USAF/WBAN codes, lat/lon, and country.

Create a mapping constant in a new helper module. For the five existing stations:

| GHCN ID | Location | ISD USAF-WBAN |
|---------|----------|---------------|
| USW00094728 | New York Central Park | 725033-94728 |
| USW00023174 | Los Angeles LAX | 722950-23174 |
| UKW00035065 | London Heathrow | 037720-99999 |
| JA000047662 | Tokyo | 476620-99999 |
| ASN00086282 | Melbourne | 948660-99999 |

These USAF-WBAN pairs must be verified against `isd-history.csv` during implementation.

### 2. Create the ISD helper module

Create `apps/datascience/shared/isd_helper.py`:

```python
ISD_BASE_URL = "https://www.ncei.noaa.gov/data/global-hourly/access"
# URL pattern: {ISD_BASE_URL}/{year}/{usaf_wban}.csv

ISD_STATIONS = [
    ("725033-94728", "USW00094728", "new_york_central_park"),
    ("722950-23174", "USW00023174", "los_angeles_lax"),
    ("037720-99999", "UKW00035065", "london_heathrow"),
    ("476620-99999", "JA000047662", "tokyo"),
    ("948660-99999", "ASN00086282", "melbourne"),
]
```

Functions:
- `download_isd_year(usaf_wban, year, output_dir="/tmp")` -- Downloads the CSV for one station-year. Returns local path.
- `parse_isd_csv(csv_path)` -- Parses the NOAA ISD CSV format. The ISD "global hourly" CSV has columns like `DATE`, `TMP`, `DEW`, `SLP`, `WND`, `VIS`, `AA1` (precipitation). Each encoded as a composite string (e.g., `TMP` = `+0150,1` meaning 15.0C, quality flag 1). Returns a pandas DataFrame with parsed/decoded columns.
- `download_and_parse_isd(usaf_wban, year, output_dir="/tmp")` -- Combines download + parse. Writes a Parquet file. Returns path.

**Columns to extract from ISD records:**
- `date` (datetime, hourly resolution)
- `temperature_c` (float, from TMP field, divide by 10)
- `dew_point_c` (float, from DEW field)
- `sea_level_pressure_hpa` (float, from SLP field)
- `wind_direction_deg` (int, from WND field)
- `wind_speed_mps` (float, from WND field, divide by 10)
- `visibility_m` (float, from VIS field)
- `precipitation_mm` (float, from AA1 field if present)
- Quality flags for each field (keep as separate columns for filtering)

### 3. Handle CDO API as an alternative/supplement

The NOAA Climate Data Online (CDO) API provides structured JSON access:
- Base URL: `https://www.ncdc.noaa.gov/cdo-web/api/v2/`
- Requires a free API token (register at `www.ncdc.noaa.gov/cdo-web/token`).
- Rate limit: 5 requests per second, 10,000 requests per day.

**Token management:**
- Store the CDO token as an Airflow Variable (`cdo_api_token`) accessible via `Variable.get("cdo_api_token")`.
- Set the variable via Airflow CLI: `airflow variables set cdo_api_token <token>`.
- Alternatively, pass as environment variable `CDO_API_TOKEN` in the pod YAML.

**Decision:** Prioritize ISD (no API key, bulk download) for the initial implementation. Add CDO API support as a future enhancement for structured queries.

### 4. Create the DAG file

Create `apps/datascience/airflow/dags/dag_download_isd.py`:

**Schedule:** Weekly on Sunday at 04:00 UTC. ISD data is updated daily but hourly data for past years is stable -- weekly is sufficient for a dev environment.

**DAG structure:**
```
for each station:
  for each year in [current_year - 1, current_year]:
    check_isd_{station}_{year}  -->  download_parse_isd_{station}_{year}  -->  upload_isd_{station}_{year}
                                                                                |
all uploads  ----------------------------------------------------------------->  all_done
```

Only fetch current year and previous year to limit data volume. Full historical backfill can be done manually via a notebook.

**MinIO storage layout:**
```
weather-raw/
  isd/
    {ghcn_station_id}/
      {year}.parquet    -- one Parquet file per station per year
```

Use the GHCN station ID (not the ISD USAF-WBAN) as the directory name to maintain alignment with existing data.

**ShortCircuit logic:** Check if `isd/{station_id}/{year}.parquet` exists in MinIO. For the current year, always re-download (data is still accumulating). For past years, skip if the file exists.

### 5. ISD CSV parsing details

The ISD "global hourly" format from `https://www.ncei.noaa.gov/data/global-hourly/access/` is a proper CSV (not the older fixed-width format). Key parsing considerations:

- The `TMP` column contains values like `+0150,1` -- split on comma, first part is temperature in tenths of degrees C (divide by 10), second part is quality flag.
- Missing values are encoded as `+9999,9` -- convert to `NaN`.
- The `WND` column is composite: `direction,direction_quality,type,speed,speed_quality` -- split on comma, extract fields 0 (direction in degrees) and 3 (speed in tenths of m/s).
- Use pandas `str.split()` vectorized operations for efficient parsing.

### 6. Manage data volume

ISD files can be 50-200 MB per station per year (raw CSV). After parsing to selected columns and converting to Parquet with compression:
- Expect ~5-20 MB per station per year (Parquet with snappy compression).
- 5 stations x 2 years = ~100-200 MB total -- manageable for MinIO in a dev environment.

Set `execution_timeout` to 30 minutes per task (ISD files are large and NOAA servers can be slow).

## Files to Create/Modify

- **Create:** `apps/datascience/shared/isd_helper.py` -- ISD download/parse functions and station mapping
- **Create:** `apps/datascience/airflow/dags/dag_download_isd.py` -- Airflow DAG
- **Modify:** `apps/datascience/shared/weather_sources.py` -- add `ISD_STATION_MAP` dict mapping GHCN IDs to ISD USAF-WBAN codes (optional, could live in `isd_helper.py` instead)

## Testing

1. **Verify station mapping:** Download `isd-history.csv` and confirm that each USAF-WBAN code maps to the correct lat/lon near the GHCN station.
2. **Manual download test:** Run `download_isd_year("725033-94728", 2024, "/tmp")` from a Python shell. Verify the CSV downloads and is parseable.
3. **Parse validation:** Check that `parse_isd_csv()` produces a DataFrame with the expected columns, reasonable temperature ranges (-50 to 50 C), and no unexpected NaN rates (some missing data is expected, but >50% NaN in temperature would indicate a parsing bug).
4. **Parquet round-trip:** Upload a parsed Parquet to MinIO with `upload_dataframe()`, then read it back with `read_parquet()` and compare row counts.
5. **DAG trigger:** Trigger `dag_download_isd` manually in Airflow UI. Verify Parquet files appear in `weather-raw/isd/{station_id}/` in MinIO.
6. **Idempotency:** Re-trigger -- past-year tasks should be skipped, current-year task should re-download.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| ISD files are large (50-200 MB raw CSV per station-year) | Parse only needed columns; store as compressed Parquet (~10x smaller) |
| NOAA servers are slow / return 503 during maintenance | 30-minute execution timeout; 1 retry with 5-minute delay; weekly schedule means a missed run is recovered next week |
| ISD station IDs may not map cleanly to GHCN IDs | Verify mapping against `isd-history.csv` before implementation; fall back to lat/lon proximity matching |
| ISD CSV format is complex with encoded composite fields | Write thorough parsing unit tests; log per-column NaN rates as a sanity check |
| CDO API token management adds operational complexity | Defer CDO to a future enhancement; ISD requires no token |
| Disk usage in the Airflow container during download | Stream to /tmp, parse, upload to MinIO, then delete local file (same pattern as existing DAGs) |

## Dependencies

- **Requires:** The `GHCN_STATIONS` list in `weather_sources.py` (already exists).
- **Benefits from:** "Use Postgres for Airflow metadata" (enables parallel downloads with LocalExecutor).
- **Feeds into:** "Notebook 05: Forecast skill evaluation" (hourly actuals for verification), "Jupyter notebook for multi-source data fusion" (ISD provides wind/pressure data not in GHCN-Daily).

## Estimated Complexity

**Medium** -- The ISD CSV parsing is the most complex part due to the composite field encoding. The DAG structure itself follows established patterns. Station ID mapping requires one-time research.
